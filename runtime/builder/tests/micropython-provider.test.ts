/**
 * Sprint 24 (M1): the MicroPython Build syntax check. The interpreter's own compiler (mpy-cross,
 * pinned, from the v1.29.0 source release) compiles main.py in the build sandbox; a compile error
 * fails the Build with file, line and the compiler's own message. It only compiles: the image
 * still carries main.py as source. The pinned tool missing or changed: the profile is not offered.
 *
 * With TBI_MICROPYTHON_HOME (a provisioned build home, provision.sh micropython-tools) the last
 * block runs the real compiler as a child process.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ESP32_MICROPYTHON_PROFILE } from '@tbi-lab/domain';
import {
  MicroPythonProvider,
  mpyCrossDiagnostic,
  type MicroPythonProfileRecord,
} from '../micropython.js';
import record from '../profiles/esp32-micropython-1.29.json' with { type: 'json' };
import type { ToolRunner } from '../runner.js';
import type { RunResult } from '../run.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 's24-mpy-'));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const job = (text: string) => ({
  dir: tmp(),
  files: [{ name: 'main.py', text }],
  signal: new AbortController().signal,
});

describe('mpy-cross diagnostics', () => {
  it('a parser error: the line and the compiler’s message', () => {
    expect(
      mpyCrossDiagnostic(
        'Traceback (most recent call last):\n  File "main.py", line 4\nSyntaxError: invalid syntax\n',
        'main.py',
      ),
    ).toEqual({
      severity: 'error',
      file: 'main.py',
      line: 4,
      message: 'SyntaxError: invalid syntax',
    });
  });
  it('a compiler error (with "in <module>") and an indentation error', () => {
    expect(
      mpyCrossDiagnostic(
        "Traceback (most recent call last):\n  File \"main.py\", line 2, in <module>\nSyntaxError: 'break'/'continue' outside loop\n",
        'main.py',
      ),
    ).toMatchObject({ line: 2, message: "SyntaxError: 'break'/'continue' outside loop" });
    expect(
      mpyCrossDiagnostic(
        'Traceback (most recent call last):\n  File "main.py", line 3\nIndentationError: unindent doesn\'t match any outer indent level\n',
        'main.py',
      ),
    ).toMatchObject({
      line: 3,
      message: "IndentationError: unindent doesn't match any outer indent level",
    });
  });
  it('anything else is not a compiler diagnostic', () => {
    expect(mpyCrossDiagnostic('', 'main.py')).toBeNull();
    expect(mpyCrossDiagnostic('Segmentation fault\n', 'main.py')).toBeNull();
  });
});

describe('the MicroPython provider runs the check first', () => {
  const fail: RunResult = {
    code: 1,
    signal: null,
    stdout: '',
    stderr:
      'Traceback (most recent call last):\n  File "main.py", line 2\nSyntaxError: invalid syntax\n',
    truncated: false,
    aborted: false,
  };
  const fakeRunner = (result: RunResult, calls: unknown[]): ToolRunner => ({
    home: '/opt/tbi-micropython',
    jobPath: () => '/job',
    prepare: async () => {},
    run: async (_dir, file, args, opts) => {
      calls.push({ file, args, cwd: opts.cwd, env: opts.env });
      return result;
    },
  });

  it('a SyntaxError fails the Build with file, line and message; no image is made', async () => {
    const calls: unknown[] = [];
    const p = new MicroPythonProvider({
      profile: ESP32_MICROPYTHON_PROFILE,
      record: record as MicroPythonProfileRecord,
      home: tmp(),
      viewHome: '/opt/tbi-micropython',
      runner: fakeRunner(fail, calls),
    });
    const out = await p.build(job('x = (1,\nprint(x)\n'));
    expect(out).toMatchObject({
      ok: false,
      failure: 'compile_error',
      diagnostics: [
        { severity: 'error', file: 'main.py', line: 2, message: 'SyntaxError: invalid syntax' },
      ],
    });
    expect(out.imagePath).toBeUndefined();
    // Exactly one step: the pinned compiler, compile only, from the program's directory.
    expect(calls).toEqual([
      {
        file: '/opt/tbi-micropython/bin/mpy-cross',
        args: ['-march=xtensawin', '-o', '/job/check.mpy', 'main.py'],
        cwd: '/job/src',
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      },
    ]);
  });

  it('an unexpected compiler failure is an internal failure, never a success', async () => {
    const p = new MicroPythonProvider({
      profile: ESP32_MICROPYTHON_PROFILE,
      record: record as MicroPythonProfileRecord,
      home: tmp(),
      runner: fakeRunner({ ...fail, code: null, signal: 'SIGSEGV', stderr: '' }, []),
    });
    expect(await p.build(job('print(1)\n'))).toMatchObject({ ok: false, failure: 'internal' });
  });

  it('the compiler missing or changed: the toolchain does not verify (profile not offered)', async () => {
    const home = tmp();
    mkdirSync(join(home, 'bin'));
    mkdirSync(join(home, 'firmware'));
    const files: Record<string, string> = {};
    for (const rel of ['bin/tbi-mklfs', 'firmware/esp32-generic-1.29.0-4mb.bin', 'bin/mpy-cross']) {
      writeFileSync(join(home, rel), rel);
      files[rel] = createHash('sha256').update(rel).digest('hex');
    }
    const rec = (pins: Record<string, string>) => ({
      ...(record as MicroPythonProfileRecord),
      files: { arm64: pins, x64: pins },
    });
    const ok = new MicroPythonProvider({
      profile: ESP32_MICROPYTHON_PROFILE,
      record: rec(files),
      home,
    });
    await expect(ok.verifyToolchain()).resolves.toBeUndefined();
    rmSync(join(home, 'bin/mpy-cross'));
    await expect(ok.verifyToolchain()).rejects.toThrow(/bin\/mpy-cross/);
    writeFileSync(join(home, 'bin/mpy-cross'), 'another compiler');
    await expect(ok.verifyToolchain()).rejects.toThrow(/bin\/mpy-cross does not match its pin/);
    // The shipped profile pins it.
    expect(Object.keys((record as MicroPythonProfileRecord).files.arm64!)).toContain(
      'bin/mpy-cross',
    );
  });

  it('the profile hash covers the check and the runtime capabilities (cached builds are redone)', () => {
    const base = { profile: ESP32_MICROPYTHON_PROFILE, home: tmp() };
    const r = record as MicroPythonProfileRecord;
    const a = new MicroPythonProvider({ ...base, record: r }).profileHash;
    const b = new MicroPythonProvider({
      ...base,
      record: r,
      runtimeCapabilities: ['i2c', 'unmodelled'],
    }).profileHash;
    const c = new MicroPythonProvider({
      ...base,
      record: { ...r, syntaxCheck: { ...r.syntaxCheck, args: [] } },
    }).profileHash;
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

const HOME = process.env.TBI_MICROPYTHON_HOME ?? '';
describe.skipIf(!HOME)('the real pinned mpy-cross (TBI_MICROPYTHON_HOME)', () => {
  const p = () =>
    new MicroPythonProvider({
      profile: ESP32_MICROPYTHON_PROFILE,
      record: record as MicroPythonProfileRecord,
      home: HOME,
    });
  it('verifies against its pins', async () => {
    await expect(p().verifyToolchain()).resolves.toBeUndefined();
  });
  it('reports the line of a SyntaxError and of an IndentationError', async () => {
    for (const [src, line, message] of [
      ['import time\nx = (1,\nprint(x)\n', 4, 'SyntaxError: invalid syntax'],
      // MicroPython's own lexer names the line BEFORE a bad dedent (the board reports the same).
      [
        'def f():\n    return 1\n  return 2\n',
        2,
        "IndentationError: unindent doesn't match any outer indent level",
      ],
      ['for i in range(3):\n    pass\nbreak\n', 3, "SyntaxError: 'break'/'continue' outside loop"],
    ] as const) {
      const out = await p().build(job(src));
      expect(out, src).toMatchObject({
        ok: false,
        failure: 'compile_error',
        diagnostics: [{ file: 'main.py', line, message }],
      });
    }
  });
  it('a valid program (native emitter included) builds, the image holds the source', async () => {
    const src =
      'import micropython\n@micropython.native\ndef f(x):\n    return x + 1\nprint(f"{f(1)}")\n';
    const j = job(src);
    const out = await p().build(j);
    expect(out.ok, JSON.stringify(out.diagnostics)).toBe(true);
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(out.imagePath!).includes(Buffer.from(src))).toBe(true);
  });
});

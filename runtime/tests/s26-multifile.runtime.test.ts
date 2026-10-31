/**
 * Sprint 26 acceptance on the real stack: the pinned Arduino toolchain and the genuine MicroPython
 * interpreter, built by the real build service, run by the Session Host on real QEMU (Runtime v5).
 *
 * Arduino/C++ (the real arduino-cli and core 3.3.12):
 *   - the three-file LCD example (sketch.ino, display.h, display.cpp) with the managed library
 *     LiquidCrystal_PCF8574 2.2.0 builds, reproducibly (two fresh services, identical bytes);
 *   - the library exists for a build only when the request pins it;
 *   - file/line diagnostics name the project file; duplicate symbols and undefined references
 *     are link errors with no artifact; sources under src/ compile;
 *   - on QEMU the LCD shows the program's text; editing display.cpp changes what it shows; a
 *     clock above the PCF8574's rating is refused by name (the library cannot bypass it).
 * MicroPython (the genuine interpreter, real QEMU):
 *   - main.py imports display.py, which imports the managed library from /lib: the LCD shows the
 *     text; a package (pkg/__init__.py, pkg/mod.py) is imported and executed in the guest;
 *   - a syntax error names its module and line; an import of a module the project does not have is
 *     refused at Build.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ESP32_ARDUINO_PROFILE,
  ESP32_MICROPYTHON_PROFILE,
  programBuildFiles,
  type ProgramSource,
} from '@tbi-lab/domain';
import { ArduinoEsp32Provider, type ArduinoProfileRecord } from '../builder/arduino.js';
import { MicroPythonProvider, type MicroPythonProfileRecord } from '../builder/micropython.js';
import { Grants } from '../builder/grants.js';
import type { BuildRequest, BuildResult } from '../builder/protocol.js';
import { BuildService, DEFAULT_LIMITS } from '../builder/service.js';
import { ArtifactStore } from '../builder/store.js';
import arduinoRecord from '../builder/profiles/esp32-arduino-3.3.12.json' with { type: 'json' };
import mpyRecord from '../builder/profiles/esp32-micropython-1.29.json' with { type: 'json' };
import { recordEvidence } from '../harness/env.js';
import { PROTOCOL, type CreateSessionRequest } from '../host/protocol.js';
import type { HostSession } from '../host/session.js';
import { serialText, waitEvent } from '../host/tests/support.js';
import { open } from '../host/tests/r1-support.js';
import { TEST_TICKET_KEY, principalFor } from '../identity/test-gate.js';
import { openAccessPolicy } from '../policy/testing.js';
import { realHost } from './r2-support.js';
import { RT, runtimeCaps, terminal } from './s24-support.js';

const A = principalFor();
const LCD_LIB = { id: 'arduino.liquidcrystal-pcf8574', version: '2.2.0' };
const PY_LIB = { id: 'micropython.python-lcd', version: '0.0.0-git.7affb0b' };
const store = RT ? mkdtempSync(join('/var/tmp', 's26-store-')) : '';
const dirs: string[] = [];
const host = realHost(RT ? { artifactsDir: store, leaseMs: 600_000 } : {});
const evidence: Record<string, unknown> = {};
afterAll(async () => {
  await host.shutdown();
  for (const d of [store, ...dirs]) if (d) rmSync(d, { recursive: true, force: true });
  if (RT) recordEvidence('s26-multifile', evidence);
});

/** A build service with both real providers on the provisioned runtime's capabilities. */
function service(storeDir = store): BuildService {
  const work = mkdtempSync(join('/var/tmp', 's26-work-'));
  dirs.push(work);
  return new BuildService(
    [
      new ArduinoEsp32Provider({
        profile: ESP32_ARDUINO_PROFILE,
        record: arduinoRecord as ArduinoProfileRecord,
        home: join(RT, 'arduino'),
        retainedOutputBytes: 256 * 1024,
        runtimeCapabilities: runtimeCaps(),
      }),
      new MicroPythonProvider({
        profile: ESP32_MICROPYTHON_PROFILE,
        record: mpyRecord as MicroPythonProfileRecord,
        home: join(RT, 'micropython'),
        runtimeCapabilities: runtimeCaps(),
      }),
    ],
    new ArtifactStore({ dir: storeDir, capBytes: 256 * 1024 * 1024, graceMs: 0 }),
    work,
    DEFAULT_LIMITS,
    {
      grants: new Grants(':memory:'),
      ticketKey: TEST_TICKET_KEY,
      systemKeys: new Set(),
      ...openAccessPolicy(),
    },
  );
}
let shared: BuildService | null = null;
const svc = () => (shared ??= service());

async function build(r: BuildRequest, s = svc()): Promise<BuildResult> {
  const out = s.submit(r, A);
  if (!('cached' in out)) await s.whenIdle();
  return 'cached' in out ? out.cached : s.status(out.buildId, out.token, A)!.result!;
}
const arduino = (
  files: { name: string; text: string }[],
  libraries?: BuildRequest['libraries'],
): BuildRequest => ({
  protocol: 'tbi-lab.build/1',
  profile: ESP32_ARDUINO_PROFILE.id,
  files,
  ...(libraries ? { libraries } : {}),
});
const python = (
  files: { name: string; text: string }[],
  libraries?: BuildRequest['libraries'],
): BuildRequest => ({
  protocol: 'tbi-lab.build/1',
  profile: ESP32_MICROPYTHON_PROFILE.id,
  files,
  ...(libraries ? { libraries } : {}),
});

/** An example's program and its app request (fixture). */
function exampleProgram(id: string, fixture: string) {
  const doc = JSON.parse(
    readFileSync(new URL(`../../app/src/examples/data/${id}.json`, import.meta.url), 'utf8'),
  ) as { programs: Record<string, ProgramSource> };
  const program = Object.values(doc.programs)[0]!;
  const fx = JSON.parse(
    readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), 'utf8'),
  ) as { request: Omit<CreateSessionRequest, 'artifact' | 'ticket'> };
  return { program, request: fx.request };
}

function start(result: BuildResult, request: Omit<CreateSessionRequest, 'artifact' | 'ticket'>) {
  const lease = svc().lease(A, result.artifact!.sha256, 600_000)!;
  const req: CreateSessionRequest = {
    ...JSON.parse(JSON.stringify(request)),
    protocol: PROTOCOL,
    artifact: { sha256: result.artifact!.sha256 },
    ticket: lease.ticket,
  };
  const s = open(host, req);
  expect(s.state, JSON.stringify(s.status().detail)).toBe('ready');
  expect(s.run()).toEqual({ ok: true });
  return { s, req };
}

type Lcd = { backlight?: boolean; displayOn?: boolean; line1?: string; line2?: string };
const lcdState = (s: HostSession, id: string): Lcd | undefined =>
  s.log
    .since(0)
    .filter((e) => e.type === 'electrical')
    .map(
      (e) =>
        (e as unknown as { outcome: { components: Record<string, { state?: Lcd }> } }).outcome
          .components[id]?.state,
    )
    .filter((x): x is Lcd => !!x)
    .at(-1);
const pad = (t: string) => t.padEnd(16, ' ');

async function showsText(s: HostSession, lcd: string, line1: string, line2: string) {
  await waitEvent(
    s,
    () => {
      const st = lcdState(s, lcd);
      return st?.line1 === pad(line1) && st?.line2 === pad(line2);
    },
    240_000,
  );
  return lcdState(s, lcd)!;
}

describe.skipIf(!RT)(
  'Sprint 26: multi-file Arduino/C++ with a managed library (real toolchain)',
  () => {
    const { program, request } = RT
      ? exampleProgram('esp32-lcd-library', 's26-esp32-lcd-library-session.json')
      : ({} as ReturnType<typeof exampleProgram>);
    const files = RT ? programBuildFiles(program) : [];
    const lcd = RT
      ? request.circuit.components.find((c) => c.type === 'display.lcd1602_i2c')!.id
      : '';

    it('the three-file example builds with the pinned library, reproducibly; the build requires i2c', async () => {
      expect(program.libraries).toEqual([LCD_LIB]);
      expect(files.map((f) => f.name)).toEqual(['sketch.ino', 'display.cpp', 'display.h']);
      const r = await build(arduino(files, program.libraries));
      expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true);
      expect(r.features?.unsupported).toEqual([]);
      expect(r.features?.requires).toEqual(expect.arrayContaining(['i2c', 'input-read']));
      // Again from scratch (fresh store, fresh jobs): the same bytes.
      const other = mkdtempSync(join('/var/tmp', 's26-store2-'));
      dirs.push(other);
      const again = await build(arduino(files, program.libraries), service(other));
      expect(again.artifact!.sha256).toBe(r.artifact!.sha256);
      // The same input in the same service: a cache hit, no compilation.
      expect('cached' in svc().submit(arduino(files, program.libraries), A)).toBe(true);
      evidence.arduinoArtifact = r.artifact!.sha256;
    }, 900_000);

    it('the library exists for a build only when pinned: unpinned, the include fails in display.cpp', async () => {
      const r = await build(arduino(files));
      expect(r.ok).toBe(false);
      expect(r.artifact).toBeUndefined();
      expect(r.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: 'error',
            file: 'display.cpp',
            line: 2,
            message: expect.stringContaining('LiquidCrystal_PCF8574.h'),
          }),
        ]),
      );
    }, 900_000);

    it('diagnostics name the project file and line; link errors leave no artifact; src/ compiles', async () => {
      const withError = files.map((f) =>
        f.name === 'display.cpp'
          ? { ...f, text: f.text.replace('lcd.clear();', 'lcd.clear()') }
          : f,
      );
      const e1 = await build(arduino(withError, program.libraries));
      expect(e1.ok).toBe(false);
      const line = files
        .find((f) => f.name === 'display.cpp')!
        .text.split('\n')
        .findIndex((l) => l.includes('lcd.clear();'));
      expect(e1.diagnostics.find((d) => d.severity === 'error')).toMatchObject({
        file: 'display.cpp',
        line: line + 1, // GCC: "expected ';'" at the statement missing it (1-based)
      });
      // The same function defined in two translation units.
      const dup = await build(
        arduino([
          { name: 'sketch.ino', text: 'int twice();\nvoid setup() { twice(); }\nvoid loop() {}\n' },
          { name: 'a.cpp', text: 'int twice() { return 1; }\n' },
          { name: 'b.cpp', text: 'int twice() { return 2; }\n' },
        ]),
      );
      expect(dup.ok).toBe(false);
      expect(dup.artifact).toBeUndefined();
      // The linker's error, on the second definition's file and line (the C++ name as linked).
      expect(dup.diagnostics).toEqual([
        expect.objectContaining({
          severity: 'error',
          file: 'b.cpp',
          line: 1,
          message: expect.stringMatching(/^multiple definition of .*twice/),
        }),
      ]);
      // Declared in a header, never defined.
      const undef = await build(
        arduino([
          {
            name: 'sketch.ino',
            text: '#include "lib.h"\nvoid setup() { missing(); }\nvoid loop() {}\n',
          },
          { name: 'lib.h', text: '#pragma once\nvoid missing();\n' },
        ]),
      );
      expect(undef.ok).toBe(false);
      expect(undef.diagnostics).toEqual([
        expect.objectContaining({
          severity: 'error',
          file: 'sketch.ino',
          message: expect.stringMatching(/^undefined reference to .*missing/),
        }),
      ]);
      // No server path in any diagnostic or log.
      for (const r of [e1, dup, undef])
        expect(JSON.stringify(r.diagnostics) + r.log.text).not.toMatch(/\/home\/|\/var\/tmp\//);
      // Sources under src/ (arduino-cli compiles that folder recursively).
      const nested = await build(
        arduino([
          {
            name: 'sketch.ino',
            text: '#include "src/util/calc.h"\nvoid setup() { calc(); }\nvoid loop() {}\n',
          },
          { name: 'src/util/calc.h', text: '#pragma once\nint calc();\n' },
          { name: 'src/util/calc.cpp', text: '#include "calc.h"\nint calc() { return 42; }\n' },
        ]),
      );
      expect(nested.ok, JSON.stringify(nested.diagnostics)).toBe(true);
      // No server path in any diagnostic or log.
      for (const r of [e1, dup, undef])
        expect(JSON.stringify(r.diagnostics) + r.log.text).not.toMatch(/\/home\/|\/var\/tmp\//);
      evidence.arduinoDiagnostics = {
        syntax: e1.diagnostics,
        dup: dup.diagnostics,
        undef: undef.diagnostics,
      };
    }, 900_000);

    it('on QEMU the LCD shows the text; editing display.cpp changes what it shows', async () => {
      const r = await build(arduino(files, program.libraries));
      const { s } = start(r, request);
      const st = await showsText(s, lcd, 'TBI Lab', 'Library LCD');
      expect(st).toMatchObject({ backlight: true, displayOn: true });
      expect(serialText(s)).toContain('LCD-LIB-READY');
      s.stop();
      expect(await terminal(s)).toMatchObject({ state: 'ended' });
      // A change in one file (the second line, through display.cpp's caller) is what the LCD shows.
      const edited = files.map((f) =>
        f.name === 'display.cpp'
          ? { ...f, text: f.text.replace('lcd.print(line2);', 'lcd.print("Edited file");') }
          : f,
      );
      const r2 = await build(arduino(edited, program.libraries));
      expect(r2.artifact!.sha256).not.toBe(r.artifact!.sha256);
      const second = start(r2, request);
      await showsText(second.s, lcd, 'TBI Lab', 'Edited file');
      second.s.stop();
      await terminal(second.s);
      evidence.arduinoLcd = { first: st, edited: lcdState(second.s, lcd) };
    }, 900_000);

    it('a bus clock above the PCF8574 rating is refused by name, whatever library drives it', async () => {
      const fast = files.map((f) =>
        f.name === 'display.cpp'
          ? {
              ...f,
              text: f.text.replace(
                'lcd.begin(16, 2);',
                'lcd.begin(16, 2);\n  Wire.setClock(400000);',
              ),
            }
          : f,
      );
      const r = await build(arduino(fast, program.libraries));
      expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true);
      const { s } = start(r, request);
      expect(await terminal(s)).toMatchObject({
        state: 'failed',
        detail: { code: 'i2c_clock_exceeded' },
      });
    }, 900_000);
  },
);

describe.skipIf(!RT)(
  'Sprint 26: multi-file MicroPython with a managed library (genuine interpreter, real QEMU)',
  () => {
    const { program, request } = RT
      ? exampleProgram('mpy-lcd-library', 's26-mpy-lcd-library-session.json')
      : ({} as ReturnType<typeof exampleProgram>);
    const files = RT ? programBuildFiles(program) : [];
    const lcd = RT
      ? request.circuit.components.find((c) => c.type === 'display.lcd1602_i2c')!.id
      : '';

    it('main.py imports display.py, which imports the library from /lib: the LCD shows the text', async () => {
      expect(program.libraries).toEqual([PY_LIB]);
      const r = await build(python(files, program.libraries));
      expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true);
      expect(r.features?.unsupported).toEqual([]);
      const { s } = start(r, request);
      const st = await showsText(s, lcd, 'TBI Lab', 'MicroPython lib');
      expect(st).toMatchObject({ backlight: true, displayOn: true });
      expect(serialText(s)).toContain('LCD-LIB-READY');
      s.stop();
      await terminal(s);
      // Without the library pinned, the import is refused at Build (never a guess at run time).
      const unpinned = await build(python(files));
      expect(unpinned.ok).toBe(true);
      expect(unpinned.features?.unsupported).toEqual(['library:machine_i2c_lcd']);
      evidence.mpyLcd = st;
    }, 900_000);

    it('a package and a module are imported and executed in the guest (not just accepted by the host)', async () => {
      const r = await build(
        python([
          {
            name: 'main.py',
            text: 'import helpers\nfrom pkg.mod import twice\nimport pkg\nprint("MAIN", helpers.NAME, twice(21), pkg.READY)\n',
          },
          { name: 'helpers.py', text: 'print("HELPERS-RAN")\nNAME = "helpers"\n' },
          { name: 'pkg/__init__.py', text: 'print("PKG-INIT")\nREADY = True\n' },
          { name: 'pkg/mod.py', text: 'def twice(x):\n    return 2 * x\n' },
        ]),
      );
      expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true);
      expect(r.features?.unsupported).toEqual([]);
      const { s } = start(r, { ...request, circuit: request.circuit });
      await waitEvent(s, () => /MAIN helpers 42 True/.test(serialText(s)), 240_000);
      const out = serialText(s);
      // Executed in import order, once each, by the interpreter itself.
      expect(out.indexOf('HELPERS-RAN')).toBeLessThan(out.indexOf('PKG-INIT'));
      expect(out.match(/PKG-INIT/g)).toHaveLength(1);
      s.stop();
      await terminal(s);
      evidence.mpyPackage = out.split('\n').filter((l) => /HELPERS|PKG|MAIN/.test(l));
    }, 900_000);

    it('a syntax error names its module and line; a missing module is refused at Build', async () => {
      const bad = await build(
        python([
          { name: 'main.py', text: 'import helpers\n' },
          { name: 'helpers.py', text: 'x = 1\ndef f(:\n    pass\n' },
        ]),
      );
      expect(bad.ok).toBe(false);
      expect(bad.diagnostics[0]).toMatchObject({ severity: 'error', file: 'helpers.py', line: 2 });
      const missing = await build(python([{ name: 'main.py', text: 'import nothere\n' }]));
      expect(missing.features?.unsupported).toEqual(['library:nothere']);
    }, 900_000);
  },
);

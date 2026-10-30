/**
 * Build provider: Classic ESP32 + the GENUINE MicroPython interpreter (Sprint 19B, MicroPython M1).
 *
 * "Build" does not compile or translate anything: the user's `main.py` is written, unchanged, into
 * the interpreter's own LittleFS v2 partition (0x200000–0x400000 of the 4 MiB image, where
 * MicroPython v1.29 mounts its `vfs` when the partition table has none) by the pinned `tbi-mklfs`
 * (built from the interpreter's own littlefs sources, runtime/micropython/tbi-mklfs.c), run in the
 * same build sandbox as the Arduino tools. The image is then the pinned interpreter image with that
 * partition spliced in: a pure function of the program text (byte-reproducible).
 *
 * Python has no link-time symbol analysis. Facilities the emulator does not model are refused at
 * BUILD time by a fail-closed source analysis (pyFeatures.ts: an import allowlist, `machine` names,
 * pulls, drive strength, the CPU clock) and, for ADC, Pin.irq and a lowered clock, at RUN time by
 * Runtime v4 (`U` frames), at the access. Every MicroPython artifact therefore REQUIRES the runtime
 * capability `unmodelled`: on a runtime without it (v3 and older) it never starts (ADR-011 §1).
 *
 * Sprint 24 (M1): before the image is made, the interpreter's OWN compiler, `mpy-cross` built from
 * the same pinned v1.29.0 source release (provision.sh mpy-cross), compiles main.py in the same
 * build sandbox as every other tool (time, memory and task limits; no network). It only compiles:
 * no user code runs on the build host. A compile error it reports (SyntaxError, IndentationError,
 * …) fails the Build with the file, line and the compiler's own message; the compiled output is
 * discarded (the image still carries main.py as source, so it stays byte-reproducible). Run-time
 * errors appear as the interpreter's own traceback on the serial output, as on a real board.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, type BuildProfile } from '@tbi-lab/domain';
import type { BuildProvider, JobContext, ProviderOutput } from './provider.js';
import { LocalToolRunner, type ToolRunner } from './runner.js';
import { analyzeMicroPython, PY_FEATURES_ANALYZER } from './pyFeatures.js';
import type { Diagnostic } from './protocol.js';

export interface MicroPythonProfileRecord {
  id: string;
  filesystem: { offset: number; blockSize: number; blockCount: number };
  image: { bytes: number };
  files: Record<string, Record<string, string>>;
  /** Sprint 24: the compile-only check (a pinned file of `files`) and its fixed arguments. */
  syntaxCheck: { tool: string; version: string; args: string[] };
}

export interface MicroPythonProviderOptions {
  profile: BuildProfile;
  record: MicroPythonProfileRecord;
  /** The MicroPython build home (provision.sh micropython-tools): bin/, firmware/. */
  home: string;
  /** The same home as the tools see it (the sandbox binds it at /opt/tbi-micropython). */
  viewHome?: string;
  runner?: ToolRunner;
  /**
   * Sprint 24 (M3): bridge capabilities of the runtime tickets are issued for (provisioned
   * runtime.json): `i2c` turns `machine.I2C` into `requires: [i2c]` instead of a refusal.
   */
  runtimeCapabilities?: readonly string[];
}

const IMAGE = 'firmware/esp32-generic-1.29.0-4mb.bin';
const TOOL = 'bin/tbi-mklfs';
/** The capability every MicroPython artifact requires (run-time refusal frames, Runtime v4). */
export const MICROPYTHON_REQUIRES = ['unmodelled'] as const;

/**
 * The compile error `mpy-cross` reports, as a diagnostic: the innermost `File "...", line N` of
 * its traceback and the last line (`SyntaxError: invalid syntax`, the compiler's own words, like
 * gcc's for Arduino). Null when the output is not a compiler traceback.
 */
export function mpyCrossDiagnostic(stderr: string, fileName: string): Diagnostic | null {
  const lines = stderr.split(/\r?\n/).filter((l) => l.trim() !== '');
  let line: number | undefined;
  for (const l of lines) {
    const m = /^\s*File "[^"]*", line (\d+)/.exec(l);
    if (m) line = Number(m[1]);
  }
  const last = lines.at(-1)?.trim();
  if (line === undefined || !last || !/^[A-Za-z_][\w.]*(: .*)?$/.test(last)) return null;
  return { severity: 'error', file: fileName, line, message: last.slice(0, 500) };
}

const sha256File = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

export class MicroPythonProvider implements BuildProvider {
  readonly profile: BuildProfile;
  readonly profileHash: string;
  private readonly runner: ToolRunner;
  private readonly viewHome: string;

  constructor(private readonly opts: MicroPythonProviderOptions) {
    this.profile = opts.profile;
    // The analysis version is part of the cache key: a rule change rebuilds (and re-analyses).
    this.profileHash = createHash('sha256')
      .update(
        canonicalJson({
          record: opts.record,
          analyzer: PY_FEATURES_ANALYZER,
          // Sprint 24: the runtime's capabilities change the analysis (I2C allowed or refused).
          capabilities: [...(opts.runtimeCapabilities ?? [])].sort(),
        }),
      )
      .digest('hex');
    this.runner = opts.runner ?? new LocalToolRunner(opts.home);
    this.viewHome = opts.viewHome ?? opts.home;
  }

  async verifyToolchain(): Promise<void> {
    const key = arch() === 'arm64' ? 'arm64' : arch() === 'x64' ? 'x64' : arch();
    const pins = this.opts.record.files[key];
    if (!pins) throw new Error(`no MicroPython pins for host architecture ${key}`);
    for (const [rel, want] of Object.entries(pins))
      if (sha256File(join(this.opts.home, rel)) !== want)
        throw new Error(`MicroPython file ${rel} does not match its pin`);
  }

  async build(job: JobContext): Promise<ProviderOutput> {
    const p = this.profile;
    const fail = (message: string): ProviderOutput => ({
      ok: false,
      failure: 'unsupported_input',
      diagnostics: [{ severity: 'error', message }],
      log: { text: '', truncated: false },
    });
    if (job.files.length !== 1 || job.files[0]!.name !== p.fileName)
      return fail(`This environment builds exactly one file named ${p.fileName}.`);
    const source = job.files[0]!.text;
    if (Buffer.byteLength(source, 'utf8') > p.maxSourceBytes)
      return fail(`The program is larger than ${p.maxSourceBytes / 1024} KiB.`);

    const fsr = this.opts.record.filesystem;
    const J = this.runner.jobPath(job.dir);
    await this.runner.prepare(job.dir);
    await mkdir(join(job.dir, 'src'));
    await chmod(join(job.dir, 'src'), 0o770);
    await writeFile(join(job.dir, 'src', p.fileName), source);
    await chmod(join(job.dir, 'src', p.fileName), 0o660);
    // Sprint 24: compile only, with the interpreter's own compiler (from the program's directory,
    // so every message names the file as the user knows it).
    const check = this.opts.record.syntaxCheck;
    const c = await this.runner.run(
      job.dir,
      join(this.viewHome, check.tool),
      [...check.args, '-o', join(J, 'check.mpy'), p.fileName],
      {
        cwd: join(J, 'src'),
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
        signal: job.signal,
        maxOutputBytes: 64 * 1024,
      },
    );
    if (c.aborted) return this.internal('aborted', c.stderr);
    if (c.code !== 0) {
      const d = mpyCrossDiagnostic(c.stderr, p.fileName);
      if (!d) return this.internal('syntax check failed', c.stderr);
      return {
        ok: false,
        failure: 'compile_error',
        diagnostics: [d],
        log: { text: c.stderr.slice(0, 4096), truncated: c.stderr.length > 4096 },
      };
    }
    const r = await this.runner.run(
      job.dir,
      join(this.viewHome, TOOL),
      [
        join(J, 'fs.bin'),
        String(fsr.blockSize),
        String(fsr.blockCount),
        `${p.fileName}=${join(J, 'src', p.fileName)}`,
      ],
      {
        cwd: J,
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
        signal: job.signal,
        maxOutputBytes: 64 * 1024,
      },
    );
    if (r.aborted) return this.internal('aborted', r.stderr);
    if (r.code !== 0) {
      // The only input-dependent failure: the program does not fit the partition.
      if (/does not fit/.test(r.stderr))
        return {
          ...fail('The program does not fit the interpreter’s file system.'),
          failure: 'compile_error',
        };
      return this.internal('file system image failed', r.stderr);
    }
    const fs = await readFile(join(job.dir, 'fs.bin'));
    const base = await readFile(join(this.opts.home, IMAGE));
    const size = fsr.blockSize * fsr.blockCount;
    if (
      base.length !== this.opts.record.image.bytes ||
      fs.length !== size ||
      fsr.offset + size !== base.length ||
      !base.subarray(fsr.offset).every((b) => b === 0xff)
    )
      return this.internal('unexpected interpreter image or file system size', '');
    const image = Buffer.from(base);
    fs.copy(image, fsr.offset);
    await writeFile(join(job.dir, 'image.bin'), image);
    return {
      ok: true,
      imagePath: join(job.dir, 'image.bin'),
      features: this.features(source),
      diagnostics: [],
      log: { text: '', truncated: false },
    };
  }

  /** The feature report: every artifact requires `unmodelled`; I2C adds `i2c` where provided. */
  private features(source: string) {
    const f = analyzeMicroPython(source, this.opts.runtimeCapabilities ?? []);
    return {
      ...f,
      requires: [...new Set([...MICROPYTHON_REQUIRES, ...(f.requires ?? [])])].sort(),
    };
  }

  private internal(what: string, output: string): ProviderOutput {
    return {
      ok: false,
      failure: 'internal',
      diagnostics: [{ severity: 'error', message: `Build service: ${what}.` }],
      log: { text: output.slice(0, 4096), truncated: output.length > 4096 },
    };
  }
}

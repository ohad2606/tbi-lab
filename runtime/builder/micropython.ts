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
import {
  canonicalJson,
  PROGRAM_LIMITS,
  programPathIssue,
  type BuildProfile,
} from '@tbi-lab/domain';
import { libraryFiles } from '../libraries/tree.js';
import type { BuildProvider, JobContext, ProviderOutput } from './provider.js';
import { LocalToolRunner, type ToolRunner } from './runner.js';
import { analyzeMicroPython, PY_FEATURES_ANALYZER } from './pyFeatures.js';
import type { Diagnostic, FeatureReport } from './protocol.js';

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
  readonly analysisCapabilities: readonly string[];
  private readonly runner: ToolRunner;
  private readonly viewHome: string;

  constructor(private readonly opts: MicroPythonProviderOptions) {
    this.profile = opts.profile;
    this.analysisCapabilities = [...(opts.runtimeCapabilities ?? [])].sort();
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
    // Sprint 26: main.py first, then further modules and packages (the service checked the set;
    // checked again here before anything is written).
    if (job.files[0]?.name !== p.fileName)
      return fail(`The first file of a build is ${p.fileName}.`);
    const taken: string[] = [];
    let total = 0;
    for (const [i, f] of job.files.entries()) {
      if (i > 0 && programPathIssue(p.language, f.name, taken, p.fileName))
        return fail(`${f.name}: not a file name this environment builds.`);
      if (i > 0) taken.push(f.name);
      const n = Buffer.byteLength(f.text, 'utf8');
      if (n > p.maxSourceBytes)
        return fail(`${f.name} is larger than ${p.maxSourceBytes / 1024} KiB.`);
      total += n;
    }
    if (job.files.length > PROGRAM_LIMITS.maxFiles || total > PROGRAM_LIMITS.maxTotalBytes)
      return fail('The project is larger than one build takes.');
    const managed = job.libraries ?? [];
    const own = projectModules(job.files.map((f) => f.name));
    // A project module may not hide a managed library's (the program's folder comes first on
    // sys.path, before /lib).
    for (const lib of managed)
      for (const m of lib.provides)
        if (own.includes(m))
          return fail(
            `${m}.py: the managed library ${lib.name} has a module of this name. Rename the file, or remove the library from the project (Managed libraries).`,
          );

    const fsr = this.opts.record.filesystem;
    const J = this.runner.jobPath(job.dir);
    await this.runner.prepare(job.dir);
    const src = join(job.dir, 'src');
    await mkdir(src);
    await chmod(src, 0o770);
    // Every file at its relative path (folders created here; files created exclusively).
    const put = async (rel: string, data: string | Buffer, mode: number) => {
      const parts = rel.split('/');
      const target = join(src, ...parts);
      if (!target.startsWith(src + '/')) throw new Error('outside the program folder');
      for (let k = 1; k < parts.length; k++) {
        const dir = join(src, ...parts.slice(0, k));
        await mkdir(dir, { recursive: true });
        await chmod(dir, 0o770);
      }
      await writeFile(target, data, { flag: 'wx' });
      await chmod(target, mode);
    };
    for (const f of job.files) await put(f.name, f.text, 0o660);
    // Managed libraries: their modules in /lib (on MicroPython's sys.path), verified first.
    const libFiles: string[] = [];
    for (const lib of managed)
      for (const f of libraryFiles(lib))
        if (f.path.endsWith('.py')) {
          const rel = `lib/${f.path}`;
          await put(rel, f.bytes, 0o640);
          libFiles.push(rel);
        }
    // Sprint 24: compile only, with the interpreter's own compiler (from the program's directory,
    // so every message names the file as the user knows it). Sprint 26: every project file.
    const check = this.opts.record.syntaxCheck;
    for (const f of job.files) {
      const c = await this.runner.run(
        job.dir,
        join(this.viewHome, check.tool),
        [...check.args, '-o', join(J, 'check.mpy'), f.name],
        {
          cwd: join(J, 'src'),
          env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
          signal: job.signal,
          maxOutputBytes: 64 * 1024,
        },
      );
      if (c.aborted) return this.internal('aborted', c.stderr);
      if (c.code !== 0) {
        const d = mpyCrossDiagnostic(c.stderr, f.name);
        if (!d) return this.internal('syntax check failed', c.stderr);
        return {
          ok: false,
          failure: 'compile_error',
          diagnostics: [d],
          log: { text: c.stderr.slice(0, 4096), truncated: c.stderr.length > 4096 },
        };
      }
    }
    const r = await this.runner.run(
      job.dir,
      join(this.viewHome, TOOL),
      [
        join(J, 'fs.bin'),
        String(fsr.blockSize),
        String(fsr.blockCount),
        ...[...job.files.map((f) => f.name), ...libFiles].map(
          (rel) => `${rel}=${join(J, 'src', ...rel.split('/'))}`,
        ),
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
      features: this.features(
        job.files.map((f) => f.text),
        [...own, ...managed.flatMap((l) => l.provides)],
        managed,
      ),
      diagnostics: [],
      log: { text: '', truncated: false },
    };
  }

  /** The feature report: every artifact requires `unmodelled`; I2C adds `i2c` where provided. */
  private features(
    sources: readonly string[],
    modules: readonly string[] = [],
    managed: readonly { name: string; runtimeCapabilities: readonly string[] }[] = [],
  ) {
    // Sprint 26 (review M1): every file analysed on its own (a string or comment opened in one
    // file never hides another's code), merged conservatively.
    const caps = this.opts.runtimeCapabilities ?? [];
    const f = mergeReports(sources.map((s) => analyzeMicroPython(s, caps, modules)));
    // Review L3: a pinned library needs what its part needs from the runtime.
    for (const lib of managed)
      if (lib.runtimeCapabilities.every((c) => caps.includes(c)))
        f.requires = [...new Set([...(f.requires ?? []), ...lib.runtimeCapabilities])].sort();
      else f.unsupported = [...new Set([...f.unsupported, `library:${lib.name}`])].sort();
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

/**
 * Sprint 26: the importable names the project's own files provide: `helpers.py` gives `helpers`;
 * `pkg/__init__.py` makes `pkg` a package and `pkg/mod.py` then gives `pkg.mod` (a folder without
 * `__init__.py` is not claimed importable).
 */
export function projectModules(paths: readonly string[]): string[] {
  const out = new Set<string>();
  const set = new Set(paths);
  for (const path of paths) {
    if (path === 'main.py') continue;
    const parts = path.replace(/\.py$/, '').split('/');
    const dirs = parts.slice(0, -1);
    // Every folder on the way must be a package.
    if (!dirs.every((_, k) => set.has([...dirs.slice(0, k + 1), '__init__.py'].join('/'))))
      continue;
    const name = parts[parts.length - 1] === '__init__' ? dirs : parts;
    if (name.length) out.add(name.join('.'));
    for (let k = 1; k <= dirs.length; k++) out.add(dirs.slice(0, k).join('.'));
  }
  return [...out].sort();
}

/** Sprint 26: one feature report for several files (unions; any unresolved read is unresolved). */
export function mergeReports(reports: readonly FeatureReport[]): FeatureReport {
  const u = <T>(xs: T[][]) => [...new Set(xs.flat())];
  const reads = reports.map((r) => r.inputReads).filter((r) => r !== undefined);
  const requires = u(reports.map((r) => r.requires ?? [])).sort();
  return {
    internalPull: u(reports.map((r) => r.internalPull)).sort((a, b) => a - b),
    gpioInterrupt: u(reports.map((r) => r.gpioInterrupt)).sort((a, b) => a - b),
    restart: reports.some((r) => r.restart),
    unsupported: u(reports.map((r) => r.unsupported)).sort(),
    ...(requires.length ? { requires } : {}),
    ...(reads.length
      ? {
          inputReads: {
            pins: u(reads.map((r) => r.pins)).sort((a, b) => a - b),
            unresolved: reads.some((r) => r.unresolved),
          },
        }
      : {}),
  };
}

/**
 * Build provider: Classic ESP32 + Arduino/C++ with the pinned R1 toolchain (Sprint 7).
 *
 * One job: write `sketch/sketch.ino` into the private job directory, compile with arduino-cli
 * (fixed argv, JSON output, an empty user directory so no sketchbook libraries exist, a per-job
 * build cache, the pinned read-only core), merge bootloader + partitions + boot_app0 + app into
 * the 4 MiB flash image R2 runs (same layout as runtime/provision/provision.sh), then analyse
 * features. Measured on the dev host: ~26-29 s cold per build, ~76 MB of temporary files, and
 * three clean builds of the same source are byte-identical (the prefix maps remove the job path).
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, type BuildProfile } from '@tbi-lab/domain';
import { analyzeFeatures } from './features.js';
import type { Diagnostic, Severity } from './protocol.js';
import type { BuildProvider, JobContext, ProviderOutput } from './provider.js';
import { runTool } from './run.js';

export interface ArduinoProfileRecord {
  id: string;
  fqbn: string;
  sourceDateEpoch: number;
  toolchain: { arduinoEsp32: string; esptool: string; gcc: string };
  image: { chip: string; flashMode: string; flashFreq: string; flashSize: string; bytes: number };
  files: Record<string, Record<string, string>>;
}

export interface ArduinoProviderOptions {
  profile: BuildProfile;
  record: ArduinoProfileRecord;
  /** Provisioned Arduino home: `bin/arduino-cli` and `data/` (read-only for the service). */
  home: string;
  /** Raw output kept for the details view (bytes). */
  retainedOutputBytes: number;
}

/** Output the tools may produce before we stop reading (JSON wraps the compiler output). */
const TOOL_OUTPUT_CAP = 4 * 1024 * 1024;

const sha256File = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

export class ArduinoEsp32Provider implements BuildProvider {
  readonly profile: BuildProfile;
  readonly profileHash: string;
  private readonly data: string;
  private readonly cli: string;
  private readonly core: string;
  private readonly toolsBin: string;

  constructor(private readonly opts: ArduinoProviderOptions) {
    this.profile = opts.profile;
    this.profileHash = createHash('sha256').update(canonicalJson(opts.record)).digest('hex');
    this.data = join(opts.home, 'data');
    this.cli = join(opts.home, 'bin', 'arduino-cli');
    const pkgs = join(this.data, 'packages', 'esp32');
    this.core = join(pkgs, 'hardware', 'esp32', opts.record.toolchain.arduinoEsp32);
    this.toolsBin = join(pkgs, 'tools');
  }

  private get esptool() {
    return join(this.toolsBin, 'esptool_py', this.opts.record.toolchain.esptool, 'esptool');
  }

  private get nm() {
    const x32 = join(this.toolsBin, 'esp-x32');
    const version = readdirSync(x32).sort().at(-1)!;
    return join(x32, version, 'bin', 'xtensa-esp32-elf-nm');
  }

  async verifyToolchain(): Promise<void> {
    const key = arch() === 'arm64' ? 'arm64' : arch() === 'x64' ? 'x64' : arch();
    const pins = this.opts.record.files[key];
    if (!pins) throw new Error(`no toolchain pins for host architecture ${key}`);
    for (const [rel, want] of Object.entries(pins)) {
      const got = sha256File(join(this.opts.home, rel));
      if (got !== want) throw new Error(`toolchain file ${rel} does not match its pin`);
    }
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
      return fail(`The sketch is larger than ${p.maxSourceBytes / 1024} KiB.`);

    const d = (sub: string) => join(job.dir, sub);
    for (const sub of ['sketch', 'user', 'cache', 'out', 'build', 'downloads'])
      await mkdir(d(sub), { mode: 0o700 });
    await writeFile(join(d('sketch'), p.fileName), source, { mode: 0o600 });
    // Pinned read-only core; an empty user directory (no sketchbook libraries); per-job cache.
    await writeFile(
      d('cli.yaml'),
      [
        'directories:',
        `  data: ${this.data}`,
        `  downloads: ${d('downloads')}`,
        `  user: ${d('user')}`,
        'build_cache:',
        `  path: ${d('cache')}`,
        'network:',
        '  connection_timeout: 1s',
        '',
      ].join('\n'),
    );
    const maps = [
      `-ffile-prefix-map=${this.data}=/arduino-data`,
      `-ffile-prefix-map=${d('sketch')}=/sketch`,
      `-ffile-prefix-map=${job.dir}=/build`,
    ].join(' ');
    const env = {
      PATH: '/usr/bin:/bin',
      HOME: job.dir,
      TMPDIR: job.dir,
      LANG: 'C.UTF-8',
      SOURCE_DATE_EPOCH: String(this.opts.record.sourceDateEpoch),
    };
    const compile = await runTool(
      this.cli,
      [
        '--config-file',
        d('cli.yaml'),
        'compile',
        '--format',
        'json',
        '--fqbn',
        this.opts.record.fqbn,
        '--build-path',
        d('build'),
        '--output-dir',
        d('out'),
        '--build-property',
        `compiler.c.extra_flags=${maps}`,
        '--build-property',
        `compiler.cpp.extra_flags=${maps}`,
        d('sketch'),
      ],
      { cwd: d('sketch'), env, signal: job.signal, maxOutputBytes: TOOL_OUTPUT_CAP },
    );
    if (compile.aborted) return this.internal('aborted', compile.stderr);

    let result: {
      success?: boolean;
      compiler_out?: string;
      compiler_err?: string;
      builder_result?: {
        diagnostics?: {
          severity?: string;
          message?: string;
          file?: string;
          line?: number;
          column?: number;
        }[];
        used_libraries?: { name?: string }[];
      };
    };
    try {
      result = JSON.parse(compile.stdout) as typeof result;
    } catch {
      return this.internal('unreadable toolchain output', compile.stdout + compile.stderr);
    }
    const scrub = (text: string) =>
      text
        .split(d('sketch') + '/')
        .join('')
        .split(job.dir)
        .join('/build')
        .split(this.data)
        .join('/arduino-data');
    const log = this.bounded(scrub((result.compiler_out ?? '') + (result.compiler_err ?? '')));
    const diagnostics: Diagnostic[] = (result.builder_result?.diagnostics ?? []).map((x) => {
      const inSketch = x.file === join(d('sketch'), p.fileName);
      const severity = (x.severity ?? 'ERROR').toLowerCase();
      return {
        severity: (['error', 'warning', 'note'].includes(severity)
          ? severity
          : 'error') as Severity,
        ...(inSketch ? { file: p.fileName } : {}),
        ...(inSketch && typeof x.line === 'number' ? { line: x.line } : {}),
        ...(inSketch && typeof x.column === 'number' ? { column: x.column } : {}),
        message: scrub(firstLine(x.message ?? '')),
      };
    });
    if (!result.success) {
      if (diagnostics.length === 0)
        diagnostics.push({
          severity: 'error',
          message: firstLine(scrub(result.compiler_err ?? 'Build failed.')),
        });
      return { ok: false, failure: 'compile_error', diagnostics, log };
    }

    // Merge into the 4 MiB flash image (the R2 artifact form).
    const out = (suffix: string) => join(d('out'), `${p.fileName}${suffix}`);
    const image = d('image.bin');
    const merge = await runTool(
      this.esptool,
      [
        '--chip',
        this.opts.record.image.chip,
        'merge-bin',
        '--output',
        image,
        '--fill-flash-size',
        this.opts.record.image.flashSize,
        '--flash-mode',
        this.opts.record.image.flashMode,
        '--flash-freq',
        this.opts.record.image.flashFreq,
        '--flash-size',
        this.opts.record.image.flashSize,
        '0x1000',
        out('.bootloader.bin'),
        '0x8000',
        out('.partitions.bin'),
        '0xe000',
        join(this.core, 'tools', 'partitions', 'boot_app0.bin'),
        '0x10000',
        out('.bin'),
      ],
      { cwd: job.dir, env, signal: job.signal, maxOutputBytes: 64 * 1024 },
    );
    if (merge.aborted) return this.internal('aborted', merge.stderr);
    if (merge.code !== 0) return this.internal('image merge failed', merge.stdout + merge.stderr);

    const nm = await runTool(this.nm, ['--defined-only', '--format=posix', out('.elf')], {
      cwd: job.dir,
      env,
      signal: job.signal,
      maxOutputBytes: 16 * 1024 * 1024,
    });
    if (nm.code !== 0) return this.internal('symbol listing failed', nm.stderr);
    const symbols = nm.stdout.split('\n').map((l) => l.split(' ')[0] ?? '');
    const libraries =
      result.builder_result?.used_libraries?.map((l) => l.name ?? '').filter(Boolean) ??
      safeList(d('build/libraries'));

    return {
      ok: true,
      imagePath: image,
      features: analyzeFeatures({ source, symbols, libraries }),
      ...sizesOf(result.compiler_out ?? ''),
      diagnostics,
      log,
    };
  }

  private bounded(text: string): { text: string; truncated: boolean } {
    const buf = Buffer.from(text, 'utf8');
    if (buf.length <= this.opts.retainedOutputBytes) return { text, truncated: false };
    return {
      text: buf.subarray(0, this.opts.retainedOutputBytes).toString('utf8'),
      truncated: true,
    };
  }

  private internal(what: string, output: string): ProviderOutput {
    return {
      ok: false,
      failure: 'internal',
      diagnostics: [{ severity: 'error', message: `Build service: ${what}.` }],
      log: this.bounded(output),
    };
  }
}

function firstLine(text: string): string {
  return text.split('\n')[0]!.trim();
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function sizesOf(out: string): Pick<ProviderOutput, 'sizes'> {
  const prog = /Sketch uses (\d+) bytes .*?Maximum is (\d+) bytes/.exec(out);
  const data = /Global variables use (\d+) bytes .*?Maximum is (\d+) bytes/.exec(out);
  if (!prog || !data) return {};
  return {
    sizes: {
      program: Number(prog[1]),
      programMax: Number(prog[2]),
      data: Number(data[1]),
      dataMax: Number(data[2]),
    },
  };
}

export async function loadProfileRecord(path: string): Promise<ArduinoProfileRecord> {
  return JSON.parse(await readFile(path, 'utf8')) as ArduinoProfileRecord;
}

/**
 * Where the pinned build tools run (Sprint 8, D-S8-6).
 *
 * - `LocalToolRunner`: a child process of the service (development and tests), as in Sprint 7.
 * - `SandboxToolRunner`: each tool step runs as an instance of a FIXED, reviewed systemd template
 *   unit (`tbi-build-job@<job>.service`, deploy/dev-lab). The unit's sandbox is not chosen here:
 *   the service may only start or stop instances of that template (polkit), never define a unit.
 *   Inside, a small driver (build-job.ts) launches exactly one allow-listed pinned tool. The job
 *   sees the toolchain read-only at `/opt/tbi-arduino` and its own job directory at `/job` —
 *   nothing else of the host (no store, no home, no other job, no network) — under its own user,
 *   with per-job memory, CPU, task and time limits and a control-group kill.
 *
 * The provider builds tool arguments in the runner's VIEW (`home`, `jobPath`) and reads results
 * from the real job directory. Both views give bit-identical images (prefix maps, Phase 0).
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { runTool, type RunResult } from './run.js';

export interface ToolRunOptions {
  cwd: string;
  env: Record<string, string>;
  signal: AbortSignal;
  maxOutputBytes: number;
}

export interface ToolRunner {
  /** The toolchain home as the tools see it. */
  readonly home: string;
  /** The job directory as the tools see it. */
  jobPath(realJobDir: string): string;
  /** Make the (new, empty) job directory usable by the tools. */
  prepare(realJobDir: string): Promise<void>;
  /** Run one tool (paths in the tools' view). */
  run(realJobDir: string, file: string, args: string[], opts: ToolRunOptions): Promise<RunResult>;
}

export class LocalToolRunner implements ToolRunner {
  constructor(readonly home: string) {}
  jobPath(realJobDir: string): string {
    return realJobDir;
  }
  async prepare(): Promise<void> {}
  run(_job: string, file: string, args: string[], opts: ToolRunOptions): Promise<RunResult> {
    return runTool(file, args, opts);
  }
}

/** The step a job unit executes (written by the service, read by build-job.ts). */
export interface StepSpec {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  maxOutputBytes: number;
}

/** What build-job.ts reports back. */
export interface StepReport {
  code: number | null;
  signal: string | null;
  truncated: boolean;
}

export const STEP_SPEC = '.step.json';
export const STEP_REPORT = '.step-report.json';
export const STEP_STDOUT = '.step-stdout';
export const STEP_STDERR = '.step-stderr';

/** Job directory names the template accepts (polkit rule and service agree on it). */
export const JOB_NAME = /^job-[A-Za-z0-9]{6}$/;

export interface SandboxOptions {
  /** Template unit prefix, e.g. `tbi-build-job` → `tbi-build-job@<job>.service`. */
  unit: string;
  /** How `systemctl` is invoked (tests may substitute). */
  systemctl?: string;
}

/** Stop all running instances of a template unit (`<prefix>@*.service`). */
export function stopTemplateInstances(systemctl: string, prefix: string): void {
  const list = spawnSync(
    systemctl,
    ['list-units', '--no-legend', '--plain', `${prefix}@*.service`],
    {
      encoding: 'utf8',
    },
  );
  for (const line of (list.stdout ?? '').split('\n')) {
    const unit = line.trim().split(/\s+/)[0];
    if (unit && unit.startsWith(`${prefix}@`))
      spawnSync(systemctl, ['stop', unit], { stdio: 'ignore' });
  }
}

export class SandboxToolRunner implements ToolRunner {
  readonly home = '/opt/tbi-arduino';
  private readonly systemctl: string;
  constructor(private readonly opts: SandboxOptions) {
    this.systemctl = opts.systemctl ?? '/usr/bin/systemctl';
  }

  jobPath(): string {
    return '/job';
  }

  /**
   * Stop every running instance of the step template (service start: a previous process's jobs
   * must not outlive it or write into directories that are about to be swept).
   */
  stopAll(): void {
    stopTemplateInstances(this.systemctl, this.opts.unit);
  }

  /** The job unit shares the service's primary group (no setgid: RestrictSUIDSGID forbids it). */
  async prepare(realJobDir: string): Promise<void> {
    await chmod(realJobDir, 0o770);
  }

  async run(realJobDir: string, file: string, args: string[], opts: ToolRunOptions) {
    const job = basename(realJobDir);
    if (!JOB_NAME.test(job)) throw new Error(`bad job directory name: ${job}`);
    const unit = `${this.opts.unit}@${job}.service`;
    for (const f of [STEP_REPORT, STEP_STDOUT, STEP_STDERR])
      await rm(join(realJobDir, f), { force: true });
    const spec: StepSpec = {
      file,
      args,
      cwd: opts.cwd,
      env: opts.env,
      maxOutputBytes: opts.maxOutputBytes,
    };
    await writeFile(join(realJobDir, STEP_SPEC), JSON.stringify(spec), { mode: 0o640 });
    let aborted = false;
    const stop = () => {
      aborted = true;
      spawn(this.systemctl, ['stop', unit], { stdio: 'ignore' });
    };
    if (opts.signal.aborted) stop();
    else opts.signal.addEventListener('abort', stop, { once: true });
    // `start` of a oneshot unit returns when the step has finished (or was stopped/killed).
    const started = await new Promise<number | null>((resolve) => {
      const c = spawn(this.systemctl, ['start', unit], { stdio: 'ignore' });
      c.on('error', () => resolve(null));
      c.on('close', (code) => resolve(code));
    });
    opts.signal.removeEventListener('abort', stop);
    const read = async (name: string) => {
      try {
        return await readFile(join(realJobDir, name), 'utf8');
      } catch {
        return '';
      }
    };
    let report: StepReport | null;
    try {
      report = JSON.parse(await read(STEP_REPORT)) as StepReport;
    } catch {
      report = null;
    }
    const result: RunResult = {
      code: report?.code ?? null,
      signal: (report?.signal as NodeJS.Signals | null) ?? null,
      stdout: await read(STEP_STDOUT),
      // A unit that failed as a unit (memory or task limit, time limit, stopped) has no report.
      stderr: (await read(STEP_STDERR)) + (report ? '' : `sandbox unit ended (${started})`),
      truncated: report?.truncated ?? false,
      aborted: aborted || (report === null && started !== 0),
    };
    for (const f of [STEP_SPEC, STEP_REPORT, STEP_STDOUT, STEP_STDERR])
      await rm(join(realJobDir, f), { force: true });
    return result;
  }
}

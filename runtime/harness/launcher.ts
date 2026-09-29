/**
 * How a runtime (QEMU) process is started (Sprint 8, D-S8-7).
 *
 * - `directLauncher`: a child process of the caller, as in R1/R2 (tests, development).
 * - `systemdLauncher`: one instance of a FIXED, reviewed template unit per session
 *   (`tbi-qemu@<session>.service`, deploy/dev-lab). The caller may only start, signal and stop
 *   instances of that template (polkit); the unit decides the sandbox: its own user, no network,
 *   a mount view of the read-only runtime and ITS session directory only, per-session memory,
 *   CPU and task limits, and a control-group kill. `systemctl start --wait` ends when the unit
 *   ends; QEMU's exit status then comes from the unit.
 *
 * The session loop (session.ts) sees the same small process interface either way.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';

export interface LaunchSpec {
  qemu: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** The session's private directory (flash.bin and bridge.sock live here). */
  dir: string;
  flash: string;
  bridgePath: string;
  tickUs: number;
  /** Diagnostic-only QEMU monitor (never in deployment). */
  stressMainLoop: boolean;
}

export interface RuntimeProcess {
  readonly pid: number | undefined;
  readonly stderr: Readable;
  kill(signal: NodeJS.Signals): void;
  on(event: 'close', l: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', l: (e: Error) => void): this;
}

export type RuntimeLauncher = (spec: LaunchSpec) => RuntimeProcess;

export const directLauncher: RuntimeLauncher = (spec) =>
  spawn(spec.qemu, spec.args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    ...(spec.env ? { env: spec.env } : {}),
  }) as ChildProcess & RuntimeProcess;

export interface SystemdLauncherOptions {
  /** Template unit prefix, e.g. `tbi-qemu` → `tbi-qemu@<session>.service`. */
  unit: string;
  systemctl?: string;
  /** The unit's control-group directory, for the process id (cgroup v2). */
  cgroupDir?: (unit: string) => string;
}

/** Session directories are `s-<session id>`; the unit instance is the id. */
const SESSION = /^s-([0-9a-f]{32})$/;

export function systemdLauncher(opts: SystemdLauncherOptions): RuntimeLauncher {
  const systemctl = opts.systemctl ?? '/usr/bin/systemctl';
  const cgroupDir =
    opts.cgroupDir ??
    ((unit: string) =>
      `/sys/fs/cgroup/system.slice/system-${opts.unit.replace(/-/g, '\\x2d')}.slice/${unit}`);
  return (spec) => {
    const session = SESSION.exec(basename(spec.dir))?.[1];
    // The unit's view is fixed (/session/flash.bin, /session/bridge.sock): refuse anything else.
    if (!session) throw new Error(`bad session directory: ${spec.dir}`);
    if (
      spec.flash !== join(spec.dir, 'flash.bin') ||
      spec.bridgePath !== join(spec.dir, 'bridge.sock')
    )
      throw new Error('session files are not in the layout the runtime unit expects');
    if (spec.stressMainLoop) throw new Error('the monitor is not available in the runtime unit');
    if (!Number.isInteger(spec.tickUs) || spec.tickUs <= 0 || spec.tickUs > 1_000_000)
      throw new Error('bad tick');
    // QEMU runs as the runtime unit's user, a member of the session group: it may connect.
    chmodSync(spec.bridgePath, 0o660);
    // The only per-session parameter the unit reads (EnvironmentFile, one numeric value).
    writeFileSync(join(spec.dir, 'runtime.env'), `TBI_TICK_US=${spec.tickUs}\n`, { mode: 0o640 });
    const unit = `${opts.unit}@${session}.service`;
    const stderr = new PassThrough();
    const ev = new EventEmitter();
    const waiter = spawn(systemctl, ['start', '--wait', unit], { stdio: 'ignore' });
    let pidCache: number | undefined;
    const proc = Object.assign(ev, {
      get pid(): number | undefined {
        if (pidCache) return pidCache;
        try {
          const first = readFileSync(join(cgroupDir(unit), 'cgroup.procs'), 'utf8').split('\n')[0];
          pidCache = first ? Number(first) : undefined;
        } catch {
          pidCache = undefined;
        }
        return pidCache;
      },
      stderr,
      kill(signal: NodeJS.Signals) {
        spawn(systemctl, ['kill', '--kill-whom=all', `--signal=${signal}`, unit], {
          stdio: 'ignore',
        });
      },
    }) as unknown as RuntimeProcess;
    waiter.on('error', (e) => ev.emit('error', e));
    waiter.on('close', () => {
      // How QEMU itself ended, as the unit's ExecStopPost recorded it: `exited <n>` or
      // `killed|dumped <SIGNAME>`. Missing: the unit never ran QEMU (a start failure).
      let code: number | null = null;
      let signal: NodeJS.Signals | null = null;
      try {
        const [how, status] = readFileSync(join(spec.dir, 'runtime.exit'), 'utf8')
          .trim()
          .split(' ');
        if (how === 'exited') code = Number(status);
        else if (how === 'killed' || how === 'dumped')
          signal = /^[A-Z0-9]{2,8}$/.test(status ?? '')
            ? (`SIG${status}` as NodeJS.Signals)
            : 'SIGKILL';
      } catch {
        signal = null;
      }
      spawnSync(systemctl, ['reset-failed', unit], { stdio: 'ignore' });
      try {
        stderr.end(readFileSync(join(spec.dir, 'runtime.stderr')));
      } catch {
        stderr.end();
      }
      ev.emit('close', code, signal);
    });
    return proc;
  };
}

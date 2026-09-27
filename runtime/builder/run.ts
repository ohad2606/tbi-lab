/**
 * Run one toolchain executable: fixed path and argv (no shell), a clean environment, its own
 * process group (so a timeout kills the compiler and every child it started), and bounded output.
 */
import { spawn } from 'node:child_process';

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Output beyond the cap was dropped. */
  truncated: boolean;
  aborted: boolean;
}

export function runTool(
  file: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; signal: AbortSignal; maxOutputBytes: number },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group: kill(-pid) reaches every descendant
      shell: false,
    });
    let used = 0;
    let truncated = false;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const take = (sink: Buffer[]) => (chunk: Buffer) => {
      const room = opts.maxOutputBytes - used;
      if (room <= 0) {
        truncated = true;
        return;
      }
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (part.length < chunk.length) truncated = true;
      used += part.length;
      sink.push(part);
    };
    child.stdout.on('data', take(out));
    child.stderr.on('data', take(err));
    let aborted = false;
    const kill = () => {
      aborted = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    };
    if (opts.signal.aborted) kill();
    else opts.signal.addEventListener('abort', kill, { once: true });
    const done = (code: number | null, signal: NodeJS.Signals | null) => {
      opts.signal.removeEventListener('abort', kill);
      // The group may still hold grandchildren after the leader exits: always reap it.
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // group already empty
      }
      resolve({
        code,
        signal,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        truncated,
        aborted,
      });
    };
    child.on('error', () => done(null, null));
    child.on('close', done);
  });
}

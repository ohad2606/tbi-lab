/**
 * Test hygiene (Sprint 8, D-S8-13): temporary directories owned by one test process.
 *
 * Each directory is named `<prefix><pid>-XXXXXX`, removed by the caller (normally in `finally`),
 * and in any case when the process exits or receives SIGINT/SIGTERM. A process killed outright
 * (SIGKILL, a worker torn down on timeout) cannot clean up, so `sweepStaleTempDirs` removes
 * directories whose owner pid no longer runs; `ownedTempDir` sweeps its prefix before creating.
 * `TBI_TEST_TMPDIR` moves everything off a RAM-backed /tmp.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TEST_TMP_BASE = process.env.TBI_TEST_TMPDIR ?? tmpdir();

const owned = new Set<string>();
let hooked = false;

function removeAll(): void {
  for (const d of owned) rmSync(d, { recursive: true, force: true });
  owned.clear();
}

function hook(): void {
  if (hooked) return;
  hooked = true;
  process.on('exit', removeAll);
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      removeAll();
      process.exit(130);
    });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Remove `<prefix><pid>-*` directories whose owner process no longer runs. */
export function sweepStaleTempDirs(prefix: string, base = TEST_TMP_BASE): string[] {
  const pattern = new RegExp(`^${escape(prefix)}(\\d+)-`);
  const removed: string[] = [];
  for (const name of readdirSync(base)) {
    const m = pattern.exec(name);
    if (!m || alive(Number(m[1]))) continue;
    rmSync(join(base, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/** A new directory owned by this process (removed at exit at the latest). */
export function ownedTempDir(prefix: string, base = TEST_TMP_BASE): string {
  sweepStaleTempDirs(prefix, base);
  hook();
  const dir = mkdtempSync(join(base, `${prefix}${process.pid}-`));
  owned.add(dir);
  return dir;
}

/** Remove a directory created by `ownedTempDir` now. */
export function removeOwnedTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  owned.delete(dir);
}

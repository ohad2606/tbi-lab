/**
 * The sandboxed runtime launcher (deploy: one `tbi-qemu@<session>` unit per session), against a
 * fake systemctl. Sprint 13 overnight audit (#2): when a session ended, the launcher waited for
 * its unit to become inactive with synchronous child processes (`systemctl is-active` + `sleep`,
 * up to 100 rounds): the Session Host's one event loop - every other user's ticks, commands and
 * event streams - stood still meanwhile. The wait is asynchronous now.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { systemdLauncher } from '../../harness/launcher.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fake systemctl: `start --wait` returns at once; `is-active` is slow and reports the unit
 * deactivating `slowRounds` times before inactive; it records how the unit ended. */
function fakeSystemctl(slowRounds: number) {
  const root = mkdtempSync(join(tmpdir(), 'fake-systemctl-'));
  dirs.push(root);
  const script = join(root, 'systemctl');
  writeFileSync(
    script,
    `#!/bin/sh
n=$(cat "${root}/count" 2>/dev/null || echo 0)
case "$1" in
  start) exit 0 ;;
  is-active)
    sleep 0.2
    echo $((n + 1)) > "${root}/count"
    if [ "$n" -lt ${slowRounds} ]; then echo deactivating; exit 0; fi
    echo inactive; exit 3 ;;
  *) exit 0 ;;
esac
`,
  );
  chmodSync(script, 0o755);
  return script;
}

function sessionDir() {
  const root = mkdtempSync(join(tmpdir(), 'launcher-'));
  dirs.push(root);
  const dir = join(root, `s-${'a'.repeat(32)}`);
  mkdirSync(dir);
  writeFileSync(join(dir, 'bridge.sock'), '');
  writeFileSync(join(dir, 'runtime.exit'), 'exited 0\n');
  return dir;
}

describe('systemd launcher', () => {
  it('waits for the unit to end WITHOUT blocking the event loop, then reports how QEMU ended', async () => {
    const launch = systemdLauncher({
      unit: 'tbi-test-qemu',
      systemctl: fakeSystemctl(3),
      cgroupDir: () => '/nonexistent',
    });
    const dir = sessionDir();
    const proc = launch({
      qemu: '/unused',
      args: [],
      dir,
      flash: join(dir, 'flash.bin'),
      bridgePath: join(dir, 'bridge.sock'),
      tickUs: 1000,
      stressMainLoop: false,
    });
    // Another user's work on the same event loop: a 10 ms heartbeat; record its largest gap.
    let last = performance.now();
    let worstGap = 0;
    const beat = setInterval(() => {
      const now = performance.now();
      worstGap = Math.max(worstGap, now - last);
      last = now;
    }, 10);
    const ended = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
      proc.on('close', (code, signal) => resolve([code, signal])),
    );
    // The stretch from the last heartbeat to the close counts too (a synchronous wait ends with
    // the close itself, before the heartbeat could run again).
    worstGap = Math.max(worstGap, performance.now() - last);
    clearInterval(beat);
    // 4 is-active rounds x 200 ms: blocked synchronously, the heartbeat stalled >= ~800 ms.
    expect(worstGap).toBeLessThan(150);
    expect(ended).toEqual([0, null]);
  });
});

/**
 * Test hygiene (Sprint 8, D-S8-13): the e2e fake build service must not leave its temporary
 * stores behind — Sprint 7 leaked one store per browser test into the host's RAM-backed /tmp.
 * Cleanup on reset, on SIGTERM (Playwright's graceful shutdown), and a sweep of parents left by a
 * process that was killed outright.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const base = mkdtempSync(join(tmpdir(), 'tbi-hygiene-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

async function fixture() {
  vi.stubEnv('TBI_TEST_TMPDIR', base);
  vi.resetModules();
  return import('../e2e/fixtures/fake-build-service.js');
}

describe('fake build service temporary directories', () => {
  it('a reset removes the previous store and job directories; remove clears the rest', async () => {
    const f = await fixture();
    const first = f.resetFakeBuildService();
    writeFileSync(join(first.store, 'image.bin'), Buffer.alloc(1024));
    const second = f.resetFakeBuildService();
    expect(existsSync(first.store)).toBe(false);
    expect(existsSync(first.work)).toBe(false);
    expect(existsSync(second.store)).toBe(true);
    f.removeFakeBuildDirs();
    expect(readdirSync(base)).toEqual([]);
  });

  it('a start sweeps directories left by a process that no longer runs, never a live one', async () => {
    const f = await fixture();
    const dead = spawnSync(process.execPath, ['-e', '']).pid!; // has exited: its pid is free
    mkdirSync(join(base, `tbi-fake-build-service-${dead}-abc123`, 'store-x'), { recursive: true });
    const mine = join(base, `tbi-fake-build-service-${process.pid}-def456`);
    mkdirSync(mine);
    expect(f.sweepStaleFakeBuildDirs(base)).toEqual([`tbi-fake-build-service-${dead}-abc123`]);
    expect(existsSync(mine)).toBe(true);
    rmSync(mine, { recursive: true });
  });

  it('SIGTERM to its process group (Playwright graceful shutdown) removes everything it created', async () => {
    const script = join(base, '..', `tbi-hygiene-child-${process.pid}.ts`);
    const fixturePath = new URL('../e2e/fixtures/fake-build-service.ts', import.meta.url).pathname;
    writeFileSync(
      script,
      `import { startFakeBuildService } from ${JSON.stringify(fixturePath)};\n` +
        `await startFakeBuildService(0);\nprocess.stdout.write('ready\\n');\nsetInterval(() => {}, 1000);\n`,
    );
    try {
      const child = spawn('npx', ['vite-node', script], {
        env: { ...process.env, TBI_TEST_TMPDIR: base },
        stdio: ['ignore', 'pipe', 'inherit'],
        detached: true, // own process group, as Playwright starts its web servers
      });
      await new Promise<void>((resolve, reject) => {
        child.stdout!.on('data', (d: Buffer) => d.toString().includes('ready') && resolve());
        child.on('exit', () => reject(new Error('fixture exited before ready')));
      });
      expect(readdirSync(base).some((n) => n.startsWith('tbi-fake-build-service-'))).toBe(true);
      const exited = new Promise((resolve) => child.on('exit', resolve));
      // Signal the whole group, as Playwright does (npx itself does not forward SIGTERM).
      process.kill(-child.pid!, 'SIGTERM');
      await exited;
      await expect.poll(() => readdirSync(base), { timeout: 5_000 }).toEqual([]);
    } finally {
      rmSync(script, { force: true });
    }
  });
});

/**
 * BACKLOG 12/G1: the shutdown flush in a REAL process. Once nothing else holds the event loop, an
 * unref'd wait lets Node exit before the write; only a child process shows that. Temp dirs only.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FUNNEL_FILE, FUNNEL_LOCK } from '../funnel/counters.js';

const root = mkdtempSync(join(tmpdir(), 'tbi-funnel-proc-'));
const script = join(root, 'child.mjs');

beforeAll(async () => {
  await build({
    stdin: {
      contents: `
        import { FunnelCounters } from './counters.js';
        import { closeThenFlush, drainThenFlush } from './shutdown.js';
        const [dir, mode] = process.argv.slice(2);
        const c = new FunnelCounters(dir, { log: (l) => process.stdout.write(l + '\\n') });
        await c.init();
        c.increment('signup_submitted');
        process.stdout.write('ready\\n');
        const done =
          mode === 'admin'
            ? drainThenFlush(async () => {}, 5000, c)
            : closeThenFlush(async () => {}, c);
        void done.then(() => process.exit(0));
      `,
      resolveDir: fileURLToPath(new URL('../funnel', import.meta.url)),
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: script,
    logLevel: 'silent',
  });
}, 30_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Runs the child with the lock held; `freeAfterMs` after it is ready the lock is removed. */
async function run(mode: string, freeAfterMs?: number) {
  const dir = mkdtempSync(join(root, 'd-'));
  writeFileSync(join(dir, FUNNEL_LOCK), '');
  const child = spawn(process.execPath, [script, dir, mode], { timeout: 10_000 });
  let out = '';
  let readyAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  child.stdout.on('data', (b: Buffer) => {
    out += b.toString();
    if (readyAt || !out.includes('ready')) return;
    readyAt = performance.now();
    if (freeAfterMs !== undefined)
      timer = setTimeout(() => unlinkSync(join(dir, FUNNEL_LOCK)), freeAfterMs);
  });
  const code = await new Promise<number | null>((r) => child.on('close', r));
  clearTimeout(timer);
  return { dir, out, code, ms: performance.now() - readyAt };
}

describe.each(['intake', 'admin'])('%s shutdown in a child process', (mode) => {
  it('a lock freed after about 300 ms: the counts are written before the exit', async () => {
    const r = await run(mode, 300);
    expect(r.code).toBe(0);
    expect(existsSync(join(r.dir, FUNNEL_FILE))).toBe(true);
    expect(readFileSync(join(r.dir, FUNNEL_FILE), 'utf8')).toContain('"signup_submitted":1');
    expect(r.out).not.toContain('gave up');
  }, 20_000);

  it('a lock held throughout: one "flush gave up" line and a bounded exit', async () => {
    const r = await run(mode);
    expect(r.code).toBe(0);
    expect(r.out).toContain('funnel: flush gave up (lock_busy), 1 not written');
    expect(existsSync(join(r.dir, FUNNEL_FILE))).toBe(false);
    expect(r.ms).toBeLessThan(5_000);
  }, 20_000);
});

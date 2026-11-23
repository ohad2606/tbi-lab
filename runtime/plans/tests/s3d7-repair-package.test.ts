/**
 * TBI-018 s3d-7: the operator repair CLI is packaged as one self-contained bundle, built like the
 * Session Host (esbuild, node ESM) by `npm run simrepair:build` to a stable location
 * (`runtime/plans/dist/sim-journal-repair.mjs`). The bundle is built for real into a temp dir, copied
 * ALONE to another temp dir (no node_modules, no sources beside it, as on a host) and run report-only
 * on fixture state dirs: exit 0 clean, 2 torn, 3 corrupt, 1 usage. Report-only writes nothing.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { SIM_JOURNAL_FILE } from '../hostboot.js';
import { SimMeter, type SimEvent } from '../simminutes.js';
import { JournalStore } from '../store.js';
import { FakeClock } from '../time.js';
import { ADV, NOON } from './helpers.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const ENTRY = 'runtime/plans/repair-main.ts';
const OUTFILE = 'runtime/plans/dist/sim-journal-repair.mjs';
const CFG = parseConfig({ metering: { enabled: true } });
const TORN = 'abcdef0123456789\t{"t":"sim_beat","sessionId":"ffff';

const parent = mkdtempSync(join(tmpdir(), 'plans-repair-pkg-'));
afterAll(() => rmSync(parent, { recursive: true, force: true }));

/** a 0700 state dir with 3 journal events (one session closed, one open), then `tail` */
async function stateWith(tail: string) {
  const dir = join(mkdtempSync(join(parent, 's-')), 'state');
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = join(dir, SIM_JOURNAL_FILE);
  const m = await SimMeter.open(new JournalStore<SimEvent>(file), {
    config: CFG,
    clock: new FakeClock(NOON),
  });
  await m.open('e'.repeat(32), ADV, 'advanced');
  await m.close('e'.repeat(32), 'ended', ADV);
  await m.open('f'.repeat(32), ADV, 'advanced');
  if (tail) appendFileSync(file, tail);
  return { dir, file };
}

describe('repair CLI packaging (s3d-7)', () => {
  it('has a simrepair:build npm script bundling repair-main.ts like the host bundle', () => {
    const s = PKG.scripts['simrepair:build'];
    expect(s).toBe(
      `esbuild ${ENTRY} --bundle --platform=node --format=esm --target=node22 --outfile=${OUTFILE} --log-level=warning`,
    );
    // same esbuild target/format as the Session Host bundle it is operated beside
    expect(PKG.scripts['host:build']).toContain('--platform=node --format=esm --target=node22');
  });

  describe('the bundle runs alone, report-only', () => {
    let bundle = '';
    let work = '';
    beforeAll(() => {
      const build = mkdtempSync(join(parent, 'build-'));
      const args = PKG.scripts['simrepair:build']!.split(' ')
        .slice(1)
        .map((a) => (a.startsWith('--outfile=') ? `--outfile=${join(build, 'x.mjs')}` : a));
      execFileSync(join(ROOT, 'node_modules', '.bin', 'esbuild'), args, {
        cwd: ROOT,
        timeout: 60_000,
        killSignal: 'SIGKILL',
      });
      // alone in an empty directory: no node_modules and no sources to resolve against
      work = mkdtempSync(join(parent, 'host-'));
      bundle = join(work, 'sim-journal-repair.mjs');
      copyFileSync(join(build, 'x.mjs'), bundle);
    }, 70_000);

    const run = (...a: string[]) =>
      spawnSync(process.execPath, [bundle, ...a], {
        cwd: work,
        encoding: 'utf8',
        timeout: 30_000,
        killSignal: 'SIGKILL',
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: work },
      });

    it('exit 0 on a clean journal, nothing written', async () => {
      const s = await stateWith('');
      const before = readFileSync(s.file, 'utf8');
      const r = run(s.dir);
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ kind: 'clean', events: 3 });
      expect(readFileSync(s.file, 'utf8')).toBe(before);
      expect(readdirSync(s.dir)).toEqual([SIM_JOURNAL_FILE]);
    });

    it('exit 2 on a torn tail, report only: nothing written, no content printed', async () => {
      const s = await stateWith(TORN);
      const before = readFileSync(s.file, 'utf8');
      const r = run(s.dir);
      expect(r.status).toBe(2);
      expect(JSON.parse(r.stdout)).toMatchObject({
        kind: 'torn',
        events: 3,
        dropBytes: Buffer.byteLength(TORN),
      });
      expect(r.stdout + r.stderr).not.toContain(ADV);
      expect(readFileSync(s.file, 'utf8')).toBe(before);
      expect(readdirSync(s.dir)).toEqual([SIM_JOURNAL_FILE]);
    });

    it('exit 3 on corruption in the middle, nothing written', async () => {
      const s = await stateWith('');
      const lines = readFileSync(s.file, 'utf8').split('\n');
      lines[1] = `0000000000000000${lines[1]!.slice(16)}`;
      writeFileSync(s.file, lines.join('\n'));
      const before = readFileSync(s.file, 'utf8');
      const r = run(s.dir);
      expect(r.status).toBe(3);
      expect(JSON.parse(r.stdout)).toEqual({ kind: 'corrupt' });
      expect(readFileSync(s.file, 'utf8')).toBe(before);
      expect(readdirSync(s.dir)).toEqual([SIM_JOURNAL_FILE]);
    });

    it('exit 1 on usage errors and an unusable directory', () => {
      expect(run().status).toBe(1);
      expect(run('--apply').status).toBe(1);
      const r = run(join(parent, 'missing', 'state'));
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/sim journal repair: state directory missing/);
    });
  });
});

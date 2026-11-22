/** Ops-review follow-ups: compaction temp file is never a symlink target; settle/release spend must match the reservation. */
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PlanEvent } from '../events.js';
import { PlansEngine } from '../reserve.js';
import { JournalStore, MemoryStore } from '../store.js';
import { ADV, NOV, req, setup } from './helpers.js';

const mem = (events: PlanEvent[]): MemoryStore<PlanEvent> => {
  const m = new MemoryStore<PlanEvent>();
  m.events = events;
  return m;
};

describe('JournalStore.replace does not follow a planted temp path', () => {
  it('a symlink at the temp path is replaced, its target is untouched, compaction succeeds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plans-symlink-'));
    const path = join(dir, 'journal.jsonl');
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'precious');
    symlinkSync(victim, `${path}.compact-tmp`);
    const store = new JournalStore<PlanEvent>(path);
    const ev = { t: 'grant', principal: ADV } as unknown as PlanEvent;
    await store.replace([ev]);
    expect(readFileSync(victim, 'utf8')).toBe('precious');
    expect(existsSync(`${path}.compact-tmp`)).toBe(false);
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(readFileSync(path, 'utf8')).toContain('"grant"');
  });
});

describe('settle/release spend.reservedMicro must equal the reservation usdMicro', () => {
  for (const kind of ['settle', 'release'] as const) {
    it(`a ${kind} event with a mismatching reservedMicro is rejected on replay`, async () => {
      const store = new MemoryStore<PlanEvent>();
      const s = await setup({}, { store });
      await s.engine.grant(ADV, 'advanced', NOV, 'g1');
      const a = req(ADV);
      await s.engine.admit(a);
      if (kind === 'settle') await s.engine.settle(a.reqId, 100);
      else await s.engine.release(a.reqId);
      const good = await PlansEngine.open(mem([...store.events]), {
        config: s.cfg,
        clock: s.clock,
      });
      expect(good.storeProblem).toBeUndefined();
      const bad = store.events.map((e) => {
        if (e.t !== kind) return e;
        const sp = (e as { spend: { reservedMicro: number } }).spend;
        return { ...e, spend: { ...sp, reservedMicro: sp.reservedMicro + 1 } } as PlanEvent;
      });
      const e = await PlansEngine.open(mem(bad), {
        config: s.cfg,
        clock: s.clock,
      });
      expect(e.storeProblem?.kind).toBe('corrupt');
    });
  }
});

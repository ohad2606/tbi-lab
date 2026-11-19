import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PlansEngine } from '../reserve.js';
import { JournalStore, MemoryStore } from '../store.js';
import { FakeSpendProvider } from './fake-provider.js';
import { ADV, FREE, NOV, call, req, rng, setup } from './helpers.js';

// Journals live in fresh directories under the OS temp dir (left for the OS to clean).
const tmp = (): string => join(mkdtempSync(join(tmpdir(), 'plans-journal-')), 'journal.jsonl');

const PRINCIPALS = ['p_property0001', 'p_property0002', 'p_property0003'];

/** Seeded random sequence of every kind of command. Conservation is checked after each step. */
async function randomRun(seed: number, store: MemoryStore | JournalStore) {
  const rand = rng(seed);
  const s = await setup(
    { plans: { free: { perMinute: 6 }, advanced: { perMinute: 6, monthlyCredits: 40 } } },
    { store },
  );
  const open: string[] = [];
  for (const p of PRINCIPALS.slice(1)) await s.engine.grant(p, 'advanced', NOV, `g-${p}`);
  await s.engine.addPack(PRINCIPALS[1] as string, 'ai300', `pk-${seed}`);
  for (let i = 0; i < 120; i++) {
    const roll = rand();
    const p = PRINCIPALS[Math.floor(rand() * 3)] as string;
    if (roll < 0.5) {
      const r = await s.engine.admit(req(p, rand() < 0.3 ? 'deep' : 'standard'));
      if (r.ok && r.metered) open.push(r.reservation.reqId);
    } else if (roll < 0.7 && open.length) {
      await s.engine.settle(
        open.splice(Math.floor(rand() * open.length), 1)[0] as string,
        Math.floor(rand() * 2000),
      );
    } else if (roll < 0.85 && open.length) {
      await s.engine.release(open.splice(Math.floor(rand() * open.length), 1)[0] as string);
    } else if (roll < 0.9) {
      await s.engine.sweep();
    } else {
      s.clock.advance(Math.floor(rand() * 4 * 3_600_000));
    }
    for (const q of PRINCIPALS) {
      const c = s.engine.conservation(q);
      expect(c.balance + c.reserved + c.consumed + c.expired, `${q} step ${i}`).toBe(c.granted);
      expect(c.balance).toBeGreaterThanOrEqual(0);
      expect(c.reserved).toBeGreaterThanOrEqual(0);
    }
  }
  return s;
}

describe('property: conservation and replay (seeded)', () => {
  it.each([11, 22, 33, 44])(
    'seed %i: balance + reserved + consumed + expired = granted; replay == live',
    async (seed) => {
      const store = new MemoryStore();
      const s = await randomRun(seed, store);
      await s.engine.sweep();
      const replayed = await PlansEngine.open(store, { config: s.cfg, clock: s.clock });
      expect(replayed.stateJson()).toBe(s.engine.stateJson());
      expect(store.events.length).toBeGreaterThan(20);
    },
  );

  it('same on the file journal', async () => {
    const path = tmp();
    const s = await randomRun(7, new JournalStore(path));
    await s.engine.sweep();
    const replayed = await PlansEngine.open(new JournalStore(path), {
      config: s.cfg,
      clock: s.clock,
    });
    expect(replayed.stateJson()).toBe(s.engine.stateJson());
  });
});

async function build(path: string) {
  const s = await setup({}, { store: new JournalStore(path) });
  await s.engine.grant(ADV, 'advanced', NOV, 'g1');
  const a = req(ADV);
  await s.engine.admit(a);
  await s.engine.settle(a.reqId, 100);
  await s.engine.admit(req(FREE));
  return s;
}

describe('JournalStore: torn tail and corruption are reported, never skipped', () => {
  it('every byte boundary inside the last record is a torn tail; refusing until explicit recovery', async () => {
    const path = tmp();
    const s = await build(path);
    const full = readFileSync(path);
    const lines = full.toString('utf8').split('\n').filter(Boolean);
    const lastLen = Buffer.byteLength((lines.at(-1) as string) + '\n');
    const lastStart = full.length - lastLen;

    const refPath = tmp();
    writeFileSync(refPath, full.subarray(0, lastStart));
    const ref = await PlansEngine.open(new JournalStore(refPath), {
      config: s.cfg,
      clock: s.clock,
    });
    expect(ref.storeProblem).toBeUndefined();

    let checked = 0;
    for (let cut = lastStart + 1; cut < full.length; cut++) {
      const p = tmp();
      writeFileSync(p, full.subarray(0, cut));
      const e = await PlansEngine.open(new JournalStore(p), { config: s.cfg, clock: s.clock });
      expect(e.storeProblem?.kind, `cut at ${cut - lastStart}`).toBe('torn_tail');
      const r = await e.admit(req(FREE));
      expect(!r.ok && r.error.code).toBe('system_unavailable');
      if (cut % 17 === 0 || cut === full.length - 1) {
        const rec = await e.recover();
        expect(rec.ok).toBe(true);
        expect(e.stateJson()).toBe(ref.stateJson());
        expect(readFileSync(p).length).toBe(lastStart);
        expect((await e.admit(req(FREE))).ok).toBe(true);
      }
      checked += 1;
    }
    expect(checked).toBe(lastLen - 1);
    expect((await new JournalStore(refPath).load()).problem).toBeUndefined();
  });

  it('a corrupt record in the middle is not repaired by recover()', async () => {
    const path = tmp();
    const s = await build(path);
    const lines = readFileSync(path, 'utf8').split('\n');
    lines[1] = (lines[1] as string).replace('"t"', '"x"');
    writeFileSync(path, lines.join('\n'));
    const e = await PlansEngine.open(new JournalStore(path), { config: s.cfg, clock: s.clock });
    expect(e.storeProblem?.kind).toBe('corrupt');
    expect((await e.recover()).ok).toBe(false);
    const r = await e.admit(req(FREE));
    expect(!r.ok && r.error.code).toBe('system_unavailable');
  });

  it('a record without its trailing newline is a torn tail even if the checksum is valid', async () => {
    const path = tmp();
    const s = await build(path);
    truncateSync(path, readFileSync(path).length - 1);
    const e = await PlansEngine.open(new JournalStore(path), { config: s.cfg, clock: s.clock });
    expect(e.storeProblem?.kind).toBe('torn_tail');
    appendFileSync(path, '\n');
    const again = await PlansEngine.open(new JournalStore(path), { config: s.cfg, clock: s.clock });
    expect(again.storeProblem).toBeUndefined();
  });

  it('a lost record (sequence gap) refuses', async () => {
    const path = tmp();
    const s = await build(path);
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    writeFileSync(path, lines.filter((_l, i) => i !== 1).join('\n') + '\n');
    const e = await PlansEngine.open(new JournalStore(path), { config: s.cfg, clock: s.clock });
    expect(e.storeProblem?.kind).toBe('corrupt');
  });

  it('missing file is an empty journal', async () => {
    const path = tmp();
    expect(existsSync(path)).toBe(false);
    expect(await new JournalStore(path).load()).toEqual({ events: [] });
  });
});

describe('restart mid-day keeps the day total (journal rebuild)', () => {
  it('rebuilt engine has the same spend counters', async () => {
    const path = tmp();
    const s = await setup({}, { store: new JournalStore(path) });
    await call(s.engine, new FakeSpendProvider(1234), FREE);
    const again = await PlansEngine.open(new JournalStore(path), { config: s.cfg, clock: s.clock });
    expect(again.spendState().dayMicro).toBe(1234);
  });
});

describe('privacy: no e-mail, prompt or reply text in the journal or the state', () => {
  it('scan after a full scenario', async () => {
    const path = tmp();
    const s = await setup(
      { plans: { advanced: { perMinute: 100 } } },
      { store: new JournalStore(path) },
    );
    await s.engine.grant(ADV, 'advanced', NOV, 'g1');
    await s.engine.addPack(ADV, 'ai300', 'pk1');
    const provider = new FakeSpendProvider(500_000);
    const prompts = [
      'why does my LED blink secret-prompt-ALPHA',
      'my mail is someone-else-at-example',
      'deep dive BRAVO-4711',
    ];
    for (const pr of prompts) await call(s.engine, provider, ADV, 'standard', pr);
    provider.mode = 'fail';
    await call(s.engine, provider, ADV, 'deep', 'a failing prompt CHARLIE');
    const bad = await s.engine.admit(req('someone@example.com'));
    expect(!bad.ok && bad.error.code).toBe('invalid_principal');
    await s.engine.revoke(ADV);
    await s.engine.ownerPause();
    const journal = readFileSync(path, 'utf8');
    const snapshot = s.engine.stateJson();
    expect(provider.seen.length).toBeGreaterThan(4);
    for (const text of [journal, snapshot]) {
      expect(text).not.toContain('@');
      expect(text).not.toContain('someone');
      for (const seen of provider.seen) expect(text).not.toContain(seen);
    }
    expect(journal.length).toBeGreaterThan(100);
  });
});

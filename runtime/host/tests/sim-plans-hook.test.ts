/**
 * TBI-018 s3c: the Session Host's flag-off hook for sim metering. Absent or disabled = the host is
 * unchanged; an enabled adapter is refused at construction (not wired yet: fail closed).
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Principal } from '../../identity/principal.js';
import { parseConfig } from '../../plans/config.js';
import type { SimEvent } from '../../plans/simminutes.js';
import { SimHostAdapter } from '../../plans/simhost.js';
import { MemoryStore } from '../../plans/store.js';
import { FakeClock } from '../../plans/time.js';
import { fakeHost } from './support.js';

const parent = mkdtempSync(join(tmpdir(), 'tbi-simhook-'));
afterAll(() => rmSync(parent, { recursive: true, force: true }));
const P = 'p_simhooktest01' as Principal;

const adapter = (enabled: boolean) =>
  SimHostAdapter.open(new MemoryStore<SimEvent>(), {
    config: parseConfig({ metering: { enabled } }),
    clock: new FakeClock(Date.parse('2026-11-22T10:00:00Z')),
  });

describe('Session Host sim metering hook', () => {
  it('a disabled adapter (the default config) leaves the host exactly as without one', async () => {
    const plain = fakeHost('normal', { tmpParent: parent }).host;
    const store = new MemoryStore<SimEvent>();
    const off = await SimHostAdapter.open(store, {
      config: parseConfig({}),
      clock: new FakeClock(0),
    });
    const hooked = fakeHost('normal', { tmpParent: parent, simPlans: off }).host;
    try {
      expect(hooked.capacity()).toEqual(plain.capacity());
      expect(hooked.health()).toEqual(plain.health());
      for (const body of [{}, null, { ticket: 'x' }]) {
        const a = plain.create(body, P);
        const b = hooked.create(body, P);
        expect(b).toEqual(a);
      }
      expect(store.appendCalls).toBe(0);
    } finally {
      await plain.shutdown();
      await hooked.shutdown();
    }
  });

  it('an enabled adapter is refused before the host creates anything', async () => {
    const before = readdirSync(parent).length;
    const on = await adapter(true);
    expect(() => fakeHost('normal', { tmpParent: parent, simPlans: on })).toThrow(
      /not wired into the Session Host/,
    );
    expect(readdirSync(parent).length).toBe(before);
  });
});

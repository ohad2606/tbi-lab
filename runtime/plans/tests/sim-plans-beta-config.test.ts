import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../host/config.js';
import { DEFAULT_CONFIG, parseConfig } from '../config.js';
import { parsePlanMap } from '../hostboot.js';

const dir = resolve(__dirname, '../../../deploy/dev-lab/s8');
const read = (f: string): unknown => JSON.parse(readFileSync(resolve(dir, f), 'utf8'));
/** the plan map documented in the G2 doc and the staging checklist */
const BETA_PLAN_MAP = 'free=free,preview=legacy,system=legacy';

describe('beta sim-plans config (deploy/dev-lab/s8/sim-plans.beta.json)', () => {
  it('is accepted by the strict parseConfig with metering on, Free minutes unmetered', () => {
    const c = parseConfig(read('sim-plans.beta.json'));
    expect(c.metering.enabled).toBe(true);
    expect(c.sim.plans.free.monthlyMinutes).toBeNull();
    expect(c.sim.plans.free.dailyMinutes).toBeNull();
  });
  it('changes nothing else relative to the defaults', () => {
    const c = parseConfig(read('sim-plans.beta.json'));
    expect(c).toEqual({
      ...DEFAULT_CONFIG,
      metering: { enabled: true },
      sim: {
        ...DEFAULT_CONFIG.sim,
        plans: {
          ...DEFAULT_CONFIG.sim.plans,
          free: { monthlyMinutes: null, dailyMinutes: null },
        },
      },
    });
  });
  it('leaseMs equals the Session Host default lease', () => {
    expect(parseConfig(read('sim-plans.beta.json')).sim.leaseMs).toBe(
      defaultConfig({ qemu: '/x', artifactsDir: '/x', ticketKey: Buffer.alloc(32) }).leaseMs,
    );
  });
  it('every plan in policy.beta.json is mapped, and no extra names', () => {
    const policy = read('policy.beta.json') as { plans: Record<string, unknown> };
    const map = parsePlanMap(BETA_PLAN_MAP);
    expect([...map.keys()].sort()).toEqual(Object.keys(policy.plans).sort());
    expect(map.get('free')).toBe('free');
    expect(map.get('preview')).toBe('legacy');
    expect(map.get('system')).toBe('legacy');
  });
});

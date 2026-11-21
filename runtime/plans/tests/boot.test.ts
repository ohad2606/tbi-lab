import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootPlans, PlansBootError, stderrAlertSink } from '../boot.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'plans-boot-'));
const cfgFile = (body: unknown) => {
  const f = join(tmp(), 'plans.json');
  writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
  return f;
};

describe('bootPlans', () => {
  it('no env: undefined and nothing created', async () => {
    const state = join(tmp(), 'st');
    expect(await bootPlans({ TBI_ASSIST_STATE: state })).toBeUndefined();
    expect(existsSync(state)).toBe(false);
  });
  it('opted in and valid: engine, journal dir created (default under assist state)', async () => {
    const st = tmp();
    const e = await bootPlans({
      TBI_PLANS_CONFIG: cfgFile({ metering: { enabled: true } }),
      TBI_ASSIST_STATE: st,
    });
    expect(e?.cfg.metering.enabled).toBe(true);
    expect(existsSync(join(st, 'plans'))).toBe(true);
  });
  it('TBI_PLANS_STATE overrides the directory', async () => {
    const d = join(tmp(), 'x');
    await bootPlans({
      TBI_PLANS_CONFIG: cfgFile({ metering: { enabled: true } }),
      TBI_PLANS_STATE: d,
    });
    expect(readdirSync(d)).toBeDefined();
  });
  it('invalid config throws without echoing content', async () => {
    const p = bootPlans({
      TBI_PLANS_CONFIG: cfgFile({ metering: { enabled: true }, secret_x: 1 }),
    });
    await expect(p).rejects.toBeInstanceOf(PlansBootError);
    await expect(p).rejects.not.toThrow(/secret_x/);
  });
  it('unreadable / non-JSON file throws', async () => {
    await expect(bootPlans({ TBI_PLANS_CONFIG: '/nonexistent/p.json' })).rejects.toThrow(
      PlansBootError,
    );
    await expect(bootPlans({ TBI_PLANS_CONFIG: cfgFile('{nope') })).rejects.toThrow(PlansBootError);
  });
  it('metering.enabled false in the file throws and creates nothing', async () => {
    const st = tmp();
    await expect(
      bootPlans({ TBI_PLANS_CONFIG: cfgFile({}), TBI_ASSIST_STATE: join(st, 's') }),
    ).rejects.toThrow(PlansBootError);
    expect(existsSync(join(st, 's'))).toBe(false);
  });
  it('unusable state dir throws', async () => {
    const f = cfgFile({});
    await expect(
      bootPlans({
        TBI_PLANS_CONFIG: cfgFile({ metering: { enabled: true } }),
        TBI_PLANS_STATE: join(f, 'sub'),
      }),
    ).rejects.toThrow(PlansBootError);
  });
  it('stderr sink writes one JSON line', () => {
    const out: string[] = [];
    stderrAlertSink((s) => out.push(s)).alert({
      code: 'day_50',
      at: 1,
      dayMicro: 2,
      monthMicro: 3,
      dayStopMicro: 4,
      monthStopMicro: 5,
    });
    expect(JSON.parse(out[0]!)).toMatchObject({ event: 'plans_alert', code: 'day_50' });
    expect(out[0]!.endsWith('\n')).toBe(true);
  });
});

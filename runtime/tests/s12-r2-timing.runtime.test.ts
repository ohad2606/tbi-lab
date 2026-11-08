/**
 * Sprint 12 (R2) device timing at the bridge, independent of firmware startup, and the first
 * reading of a session (Gate B G-2, PM-approved 2026-10-11).
 *
 * T-DET-4's fingerprints cover everything a session publishes, including when the firmware
 * finishes its setup; a rebuilt image that starts 1 ms later changes them although the sensor
 * behaves identically. This test measures the HC-SR04's intended behaviour directly, at the
 * bridge, for every measurement the firmware makes:
 *   - the echo the Session Host schedules (J on GPIO18) is exactly the engine oracle for the
 *     trigger the firmware actually produced (GPIO5 rise/fall, exact simulated ns): rise = trigger
 *     fall + 200 us burst, width = 2 d / c(T), to the nanosecond;
 *   - the firmware's pulseIn reading R of an echo of width W satisfies T-R2-2 as revised (PM, G-2
 *     final, option (a)): floor(W - L) <= R <= floor(W + L), L = 0.4534 us (pulseIn's polling period
 *     on Runtime v2, G2-ROUND4 section 2), for every reading including the session's first (the
 *     reading s12-r2 never sees: it reads only after a live change). The contract's exception (an
 *     edge inside a documented CPU-unavailable interval, |R - W| <= 13.5 us) is documented in
 *     G2-FINAL.md; no interval is documented for TbiHcSr04, so none is granted here;
 *   - KNOWN FAILURE (F-R2-2): the former 1 us bound, kept as a mechanism-specific regression. It
 *     passes only while exactly the documented reading misses 1 us (the 4 m session's first
 *     reading, 23294 vs 23 295.091); any other reading outside 1 us, or that reading inside it,
 *     fails the case.
 * The two are separate test cases on one session per point (PM, G-2 round 3: strict bridge-edge
 * timing kept apart from firmware-visible timing), so a firmware-visible failure never hides the
 * bridge result. The firmware's startup (first trigger) is recorded, not asserted: it belongs to
 * the image and is covered by T-DET-4. Test-only instrumentation: the harness's runSession handler is wrapped to
 * observe pad events and replies; nothing in the product changes.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { hcsr04Echo } from '@tbi-lab/engine';
import { artifact, assertProvisioned, recordEvidence, runtimeInfo } from '../harness/env.js';
import { ticketFor } from '../identity/test-gate.js';
import { Circuit, open } from '../host/tests/r1-support.js';
import { realHost } from './r2-support.js';

interface Seen {
  pad: { vns: bigint; pad: number; level: number }[];
  echo: { vns: bigint; level: number }[];
  serial: string;
}
const G = globalThis as unknown as { __r2timing?: Seen };

vi.mock('../harness/session.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('../harness/session.js')>();
  type H = Parameters<typeof m.runSession>[1];
  const wrap = (h: H): H => ({
    ...h,
    pad: (e) => {
      const reply = h.pad?.(e) ?? [];
      const seen = (globalThis as unknown as { __r2timing?: Seen }).__r2timing;
      seen?.pad.push({ vns: e.vns, pad: e.pad, level: e.level });
      for (const c of reply)
        if (c.type === 'J' && c.pad === 18) seen?.echo.push({ vns: c.vns, level: c.level });
      return reply;
    },
    serial: (v, b) => {
      const seen = (globalThis as unknown as { __r2timing?: Seen }).__r2timing;
      if (seen) seen.serial += b.toString('latin1');
      h.serial?.(v, b);
    },
  });
  return {
    ...m,
    runSession: (o: Parameters<typeof m.runSession>[0], h: H) => m.runSession(o, wrap(h)),
  };
});

/** pulseIn's polling period on Runtime v2 b5b34b49cb7e4049 (G2-ROUND4 section 2). */
const L_US = 0.4534;
/** The single documented 1 us miss (F-R2-2): point, reading index, value. */
const F_R2_2 = { point: '4m-20C', index: 0, reading: 23294 };

const host = realHost();
afterAll(() => host.shutdown());
const evidence: Record<string, unknown> = {};

function sonar(distance: number, tempC: number): Circuit {
  const c = new Circuit().psu(5);
  const u = c.add('sensor.hc_sr04');
  const r1 = c.add('component.resistor');
  const r2 = c.add('component.resistor');
  c.set(u, 'distance', { value: distance, unit: 'metre' });
  c.set(u, 'airTemperature', { value: tempC, unit: 'celsius' });
  c.wire('PSU1.positive', `${u}.vcc`).wire(`${u}.gnd`, 'GND1.ref').pad(5, `${u}.trig`);
  c.ohms(r1, 1000).ohms(r2, 2000);
  c.wire(`${u}.echo`, `${r1}.a`).wire(`${r1}.b`, `${r2}.a`).wire(`${r2}.b`, 'GND1.ref');
  return c.pad(18, `${r1}.b`);
}

interface Observed {
  rows: {
    trigUs: number;
    widthNs: number;
    oracleUs: number;
    echo: { rise: bigint; fall: bigint };
    want: { rise: bigint; fall: bigint };
  }[];
  readings: number[];
}

/** One session per point: triggers, the echoes the host scheduled, and the firmware's readings. */
async function observe(distance: number, tempC: number): Promise<Observed> {
  assertProvisioned();
  const fw = artifact('TbiHcSr04');
  const seen: Seen = { pad: [], echo: [], serial: '' };
  G.__r2timing = seen;
  const s = open(host, {
    ...sonar(distance, tempC).request(fw.sha256),
    ticket: ticketFor(fw.sha256),
  });
  expect(s.state, JSON.stringify(s.status().detail)).toBe('ready');
  s.run();
  await expect
    .poll(() => [...seen.serial.matchAll(/^D \d+\r?$/gm)].length >= 10, {
      timeout: 180_000,
      interval: 50,
    })
    .toBe(true);
  s.stop();
  await s.done();
  G.__r2timing = undefined;

  // Triggers: GPIO5 rise -> fall pairs, in order.
  const trig = seen.pad.filter((p) => p.pad === 5);
  const pulses: { rise: bigint; fall: bigint }[] = [];
  for (let i = 1; i < trig.length; i++)
    if (trig[i - 1]!.level === 1 && trig[i]!.level === 0)
      pulses.push({ rise: trig[i - 1]!.vns, fall: trig[i]!.vns });
  const echoes: { rise: bigint; fall: bigint }[] = [];
  for (let i = 0; i + 1 < seen.echo.length; i += 2) {
    expect([seen.echo[i]!.level, seen.echo[i + 1]!.level]).toEqual([1, 0]);
    echoes.push({ rise: seen.echo[i]!.vns, fall: seen.echo[i + 1]!.vns });
  }
  expect(echoes.length).toBeGreaterThanOrEqual(10);
  const readings = [...seen.serial.matchAll(/^D (\d+)\r?$/gm)].map((m) => Number(m[1]));
  const rows = echoes.map((e) => {
    // The trigger this echo answers: the last one that fell before the echo rose.
    const t = pulses.filter((p) => p.fall < e.rise).at(-1)!;
    const want = hcsr04Echo(t.fall, Number(t.fall - t.rise) / 1000, distance, tempC)!;
    expect(want).not.toBeNull();
    return {
      trigUs: Number(t.fall - t.rise) / 1000,
      widthNs: Number(e.fall - e.rise),
      oracleUs: want.widthUs,
      echo: e,
      want: { rise: want.riseNs, fall: want.fallNs },
    };
  });
  evidence[`${distance}m-${tempC}C`] = {
    firstTriggerNs: pulses[0]!.rise.toString(),
    measurements: rows.length,
    triggerWidthsUs: [...new Set(rows.map((r) => r.trigUs))],
    echoWidthNs: [...new Set(rows.map((r) => r.widthNs))],
    oracleUs: rows[0]!.oracleUs,
    readingsUs: readings.slice(0, rows.length),
  };
  return { rows, readings: readings.slice(0, rows.length) };
}

const POINTS = [
  [0.1, 20],
  [1, 20],
  [4, 20],
  [1, 35],
] as const;
/** One memoised session per point, shared by its cases and the known-failure case. */
const observed = new Map<string, () => Promise<Observed>>();

describe('R2: HC-SR04 device timing at the bridge (startup-independent)', () => {
  for (const [distance, tempC] of POINTS) {
    let memo: Promise<Observed> | undefined;
    const once = () => (memo ??= observe(distance, tempC));
    observed.set(`${distance}m-${tempC}C`, once);

    it(`${distance} m at ${tempC} degC, bridge: every echo is the oracle for its trigger, to the ns`, async () => {
      const { rows } = await once();
      for (const r of rows) expect(r.echo).toEqual(r.want);
    }, 300_000);

    it(`${distance} m at ${tempC} degC, firmware: every pulseIn reading within floor(W -/+ L) (T-R2-2)`, async () => {
      const { rows, readings } = await once();
      for (const [i, r] of readings.entries()) {
        const w = rows[i]!.oracleUs;
        const msg = `${i === 0 ? 'first reading' : `reading ${i}`}: ${r} us vs oracle ${w} us`;
        expect(r, msg).toBeGreaterThanOrEqual(Math.floor(w - L_US));
        expect(r, msg).toBeLessThanOrEqual(Math.floor(w + L_US));
      }
    }, 300_000);
  }

  it('KNOWN FAILURE (F-R2-2), former 1 us bound: only the 4 m first reading misses it', async () => {
    const misses: { point: string; index: number; reading: number; oracleUs: number }[] = [];
    for (const [distance, tempC] of POINTS) {
      const { rows, readings } = await observed.get(`${distance}m-${tempC}C`)!();
      readings.forEach((r, i) => {
        if (Math.abs(r - rows[i]!.oracleUs) > 1)
          misses.push({
            point: `${distance}m-${tempC}C`,
            index: i,
            reading: r,
            oracleUs: rows[i]!.oracleUs,
          });
      });
    }
    evidence.knownFailure = { id: 'F-R2-2', misses };
    for (const m of misses)
      expect(
        m.point === F_R2_2.point && m.index === F_R2_2.index && m.reading === F_R2_2.reading,
        `unexpected failure of the 1 us bound: ${JSON.stringify(m)}`,
      ).toBe(true);
    expect(
      misses.length,
      'unexpected pass: F-R2-2 no longer reproduces; investigate before changing this case',
    ).toBe(1);
  }, 900_000);

  afterAll(() =>
    recordEvidence('s12-r2-timing', {
      runtimeId: runtimeInfo().runtimeId,
      firmware: artifact('TbiHcSr04').sha256,
      ...evidence,
    }),
  );
});

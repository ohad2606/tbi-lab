/**
 * Sprint 12 determinism of the new capabilities on the REAL runtime, through the Session Host
 * (T-DET-4: HC-SR04 at three distances; T-DET-5: DHT22 at three points; T-DET-6: I2C LCD).
 *
 * Fingerprint: every event the session publishes with a simulation time up to a fixed cut-off
 * (serial bytes, GPIO windows, electrical operating points including the LCD text, diagnostics),
 * in order. Events after the cut-off and wall-clock fields are excluded, so the wall-clock stop
 * cannot influence it. Every run of a scenario must give one fingerprint, equal to the pin for
 * this runtime generation. TBI_S12_DET_RUNS sets the runs (default 3; the pins come from 10);
 * TBI_S12_DET_UNPINNED=1 skips the pin (only when establishing it).
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { artifact, assertProvisioned, recordEvidence, runtimeInfo } from '../harness/env.js';
import { ticketFor } from '../identity/test-gate.js';
import { waitEvent } from '../host/tests/support.js';
import { Circuit, open } from '../host/tests/r1-support.js';
import { realHost } from './r2-support.js';

const RUNS = Number(process.env.TBI_S12_DET_RUNS ?? 3);
const UNPINNED = process.env.TBI_S12_DET_UNPINNED === '1';
const host = realHost();
afterAll(() => host.shutdown());

/**
 * Pins for Runtime v2 b5b34b49cb7e4049 (10 converging runs each), re-established under the fixed
 * Session Host with the reproducible firmware images (Gate B G-2 Patch B, docs/sprints/s12-evidence/
 * gate-b/G2-FINAL.md). The HC-SR04 pins encode the 4 m session's first reading 23294 (F-R2-2).
 * Sprint 13 re-pin (10 converging runs each, 2026-10-12): H2 (a23ffcd) adds the field
 * `outsideModelRange` to every supply-limited part's outcome; it is the only difference in the
 * event streams, and with it removed all seven fingerprints equal the Sprint 12 pins
 * (docs/sprints/s13-evidence/ci/PIN-DRIFT-H2.md). Sprint 12 values in that record.
 * Sprint 25 re-pin (3 converging runs each, Runtime v4 cd778dc17d8edcdd and v5 39f2229a66d45e43
 * alike, 2026-10-31): the engine adds `levelUndefined: 'floating'` to GPIO5's pin result in the
 * HC-SR04 sessions' first outcome (the trigger pad before the firmware makes it an output, held by
 * nothing). It is the only difference: with it removed the streams hash to the previous pins
 * (3dd25c5ae652c283, 4d076533f2a86241, 0307e9f722c52aa2) exactly; the DHT22 and LCD streams are
 * unchanged (~/tbi-s25/evidence/drift).
 */
const PINNED: Record<string, string> = {
  'hcsr04-0.1m': '804c4af6437261b4',
  'hcsr04-1m': '97a6c4c0d9c6528b',
  'hcsr04-4m': 'db5c592d546178ef',
  'dht22--10C-30RH': '34cb128f5dbc7182',
  'dht22-21.5C-55.2RH': '58966db12b113310',
  'dht22-60C-95RH': '9c0249a9cfec605a',
  'lcd1602-hello': '8b541851155780da',
};

interface Scenario {
  name: string;
  fw: string;
  cutoffNs: bigint;
  build: () => Circuit;
}

const sonar = (distance: number): Scenario => ({
  name: `hcsr04-${distance}m`,
  fw: 'TbiHcSr04',
  cutoffNs: 3_000_000_000n,
  build: () => {
    const c = new Circuit().psu(5);
    const u = c.add('sensor.hc_sr04');
    const r1 = c.add('component.resistor');
    const r2 = c.add('component.resistor');
    c.set(u, 'distance', { value: distance, unit: 'metre' });
    c.wire('PSU1.positive', `${u}.vcc`).wire(`${u}.gnd`, 'GND1.ref').pad(5, `${u}.trig`);
    c.ohms(r1, 1000).ohms(r2, 2000);
    c.wire(`${u}.echo`, `${r1}.a`).wire(`${r1}.b`, `${r2}.a`).wire(`${r2}.b`, 'GND1.ref');
    return c.pad(18, `${r1}.b`);
  },
});
const dht = (t: number, rh: number): Scenario => ({
  name: `dht22-${t}C-${rh}RH`,
  fw: 'TbiDht22',
  cutoffNs: 6_500_000_000n,
  build: () => {
    const c = new Circuit().psu(3.3);
    const u = c.add('sensor.dht22');
    const r = c.add('component.resistor');
    c.set(u, 'temperature', { value: t, unit: 'celsius' });
    c.set(u, 'humidity', { value: rh, unit: 'percent_rh' });
    c.wire('PSU1.positive', `${u}.vdd`).wire(`${u}.gnd`, 'GND1.ref');
    c.ohms(r, 10_000).wire(`${r}.a`, 'PSU1.positive').wire(`${r}.b`, `${u}.data`);
    return c.pad(4, `${u}.data`);
  },
});
const lcd: Scenario = {
  name: 'lcd1602-hello',
  fw: 'TbiLcd',
  cutoffNs: 3_000_000_000n,
  build: () => {
    const c = new Circuit().psu(4.5);
    const d = c.add('display.lcd1602_i2c');
    const p2 = c.add('instrument.lab_psu');
    c.set(p2, 'setpointVoltage', { value: 3.3, unit: 'volt' }).set(p2, 'outputEnabled', true);
    c.wire(`${p2}.negative`, 'GND1.ref')
      .wire('PSU1.positive', `${d}.vcc`)
      .wire(`${d}.gnd`, 'GND1.ref');
    for (const [line, gpio] of [
      ['sda', 21],
      ['scl', 22],
    ] as const) {
      const r = c.add('component.resistor');
      c.ohms(r, 4700).wire(`${r}.a`, `${p2}.positive`).wire(`${r}.b`, `${d}.${line}`);
      c.pad(gpio, `${d}.${line}`);
    }
    return c;
  },
};
const SCENARIOS = [sonar(0.1), sonar(1), sonar(4), dht(-10, 30), dht(21.5, 55.2), dht(60, 95), lcd];

async function fingerprint(sc: Scenario): Promise<string> {
  const c = sc.build();
  const fw = artifact(sc.fw);
  const s = open(host, { ...c.request(fw.sha256), ticket: ticketFor(fw.sha256) });
  expect(s.state, JSON.stringify(s.status().detail)).toBe('ready');
  s.run();
  // Past the cut-off by one publish window, so every event up to it has been published.
  await waitEvent(s, () => BigInt(s.status().simNs) > sc.cutoffNs + 20_000_000n, 180_000);
  const lines = s.log
    .since(0)
    .filter((e) => e.simNs !== null && BigInt(e.simNs) <= sc.cutoffNs && e.type !== 'state')
    .map((e) => {
      const { seq: _seq, ...rest } = e as unknown as Record<string, unknown>;
      return JSON.stringify(rest);
    });
  s.stop();
  await s.done();
  expect(lines.length).toBeGreaterThan(3);
  // Pin drift investigation: the event lines, to compare two runtimes' streams.
  if (process.env.TBI_DET_DUMP)
    writeFileSync(join(process.env.TBI_DET_DUMP, `${sc.name}.jsonl`), lines.join('\n') + '\n');
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}

const summary: Record<string, string[]> = {};

describe('Sprint 12 determinism: R2/R3 through the Session Host (T-DET-4/5/6)', () => {
  assertProvisioned();
  for (const sc of SCENARIOS) {
    it(`${sc.name}: ${RUNS} runs give one fingerprint`, async () => {
      const got: string[] = [];
      for (let i = 0; i < RUNS; i++) got.push(await fingerprint(sc));
      summary[sc.name] = got;
      console.log(`[${sc.name}] ${got.join(' ')}`);
      expect(new Set(got).size, got.join(' ')).toBe(1);
      if (!UNPINNED) expect(got[0]).toBe(PINNED[sc.name]);
    });
  }
  it('records the evidence', () => {
    recordEvidence(`s12-determinism${UNPINNED ? '-unpinned' : ''}-${RUNS}x`, {
      runtimeId: runtimeInfo().runtimeId,
      runs: RUNS,
      fingerprints: summary,
    });
  });
});

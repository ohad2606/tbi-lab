/**
 * Sprint 22 (P2): every numerical bound the logic guarantee checks use has a provenance row
 * (logic/provenance.ts) with the SAME value: document, table/row/conditions, range and kind.
 */
import { describe, expect, it } from 'vitest';
import { LVC08A_CARD, LVC1G_CARDS, type LogicCard } from '../src/index.js';
import { LOGIC_PROVENANCE } from '../src/logic/provenance.js';
import {
  I_OH_A,
  I_OL_A,
  R_PULL_OHM,
  VDD_V,
  V_IH_V,
  V_IL_V,
  V_OH_CHAR_V,
} from '../src/esp32Gpio.js';
import { ESP32_INPUT_LEAKAGE_A, ESP32_V_OL_MAX_V } from '../src/logic/bounds.js';

const row = (id: string) => {
  const r = LOGIC_PROVENANCE.find((x) => x.id === id);
  if (!r) throw new Error(`no provenance row for ${id}`);
  return r;
};
const close = (a: unknown, b: unknown) => {
  const fa = [a].flat(2) as (number | string)[];
  const fb = [b].flat(2) as (number | string)[];
  expect(fa.length).toBe(fb.length);
  fa.forEach((x, k) =>
    typeof x === 'number' ? expect(x).toBeCloseTo(fb[k] as number, 12) : expect(x).toBe(fb[k]),
  );
};
const th = (t: { v: number } | { k: number }) => ('v' in t ? t.v : t.k);

/** The card fields logic/bounds.ts and the gate models use as bounds, flattened. */
function cardBounds(c: LogicCard): Record<string, unknown> {
  return {
    vccOperating: c.vccOperating,
    inputLeakageA: c.inputLeakageA,
    iiVcc: c.iiVcc,
    ...(c.ioffA !== undefined ? { ioffA: c.ioffA } : {}),
    iccMaxA: c.iccMaxA,
    iccVcc: c.iccVcc,
    iccInputHigh: c.iccInputHigh === 'vcc' ? 'V_CC' : c.iccInputHigh,
    deltaIccA: c.deltaIccA,
    deltaIccVcc: c.deltaIccVcc,
    inputRows: c.inputRows.flatMap((r) => [r.vcc[0], r.vcc[1], th(r.vih), th(r.vil)]),
    // Per row: V_CC, then the HIGH points (amps, V_OH min), then the LOW points (amps, V_OL max).
    outputRows: c.outputRows.flatMap((r) => [
      r.vcc,
      ...r.high.flatMap((p) => [p.amps, p.volts]),
      ...r.low.flatMap((p) => [p.amps, p.volts]),
    ]),
    rangedOutput: [
      c.rangedOutput.vcc[0],
      c.rangedOutput.vcc[1],
      c.rangedOutput.amps,
      c.rangedOutput.drop,
      c.rangedOutput.low,
    ],
    inputRecommended: c.inputRecommended,
  };
}

describe('logic bound provenance (P2)', () => {
  for (const card of [...Object.values(LVC1G_CARDS), LVC08A_CARD])
    it(`${card.partNumber}: every bound has a row with the same value`, () => {
      for (const [field, value] of Object.entries(cardBounds(card))) {
        const r = row(`${card.partNumber}.${field}`);
        close(r.value, value);
        expect(r.document).toMatch(/SCES|SCAS/);
        expect(r.where.length).toBeGreaterThan(5);
      }
      expect(row(`${card.partNumber}.outputRail`).kind).toBe('guaranteed-range');
    });

  it('ESP32 pad figures: the same values, and the drive figures marked typical', () => {
    close(row('ESP32.VDD_V').value, VDD_V);
    close((row('ESP32.V_IH_FRACTION').value as number) * VDD_V, V_IH_V);
    close((row('ESP32.V_IL_FRACTION').value as number) * VDD_V, V_IL_V);
    close((row('ESP32.V_OH_FRACTION').value as number) * VDD_V, V_OH_CHAR_V);
    close((row('ESP32.V_OL_FRACTION').value as number) * VDD_V, ESP32_V_OL_MAX_V);
    close(row('ESP32.INPUT_LEAKAGE_A').value, ESP32_INPUT_LEAKAGE_A);
    close(row('ESP32.I_OH_A').value, I_OH_A);
    close(row('ESP32.I_OL_A').value, I_OL_A);
    close(row('ESP32.R_PULL_OHM').value, R_PULL_OHM);
    for (const id of ['ESP32.I_OH_A', 'ESP32.I_OL_A', 'ESP32.R_PULL_OHM'])
      expect(row(id).kind).toBe('typical');
    expect(row('ESP32.V_OH_FRACTION').where).toContain('NO test current');
  });

  it('every row is complete (manufacturer, part, document, where, applies, kind, use)', () => {
    for (const r of LOGIC_PROVENANCE)
      for (const k of [
        'manufacturer',
        'part',
        'document',
        'where',
        'applies',
        'kind',
        'use',
      ] as const)
        expect(String(r[k]).length, `${r.id}.${k}`).toBeGreaterThan(1);
  });
});

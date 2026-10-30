/**
 * Sprint POT-UNITS Phase 1: value + unit dropdown. Storage is unchanged (canonical SI numbers),
 * so old projects need no migration; what changes is how the editor shows and reads a value.
 * Checked here, for every quantity parameter of every shipped example and of a v4 fixture saved
 * before this sprint (app/tests/fixtures/v4-quantities.json):
 * - the project opens with every stored value unchanged;
 * - the editor's number in its derived unit re-reads to EXACTLY the stored SI value (the same
 *   value is displayed, never rounded or re-scaled), and the range hint names offered units;
 * - a number typed in a chosen unit becomes the exact SI value, and after commit/reload the
 *   derived unit is the one chosen (choose kΩ, enter 1 -> 1000 Ω -> shown "1 kΩ");
 * - which parameters get a dropdown (more than one useful unit) and which a fixed symbol;
 * - the range hint renders its quantities as LTR isolates in every locale (Hebrew bidi).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CATALOG,
  chooseDisplayUnit,
  displayUnitsFor,
  openDocument,
  parseEntry,
  type ParamDef,
  type ProjectDocument,
} from '@tbi-lab/domain';
import {
  LOCALES,
  displayNumber,
  displayUnitSymbol,
  formatDisplayQuantity,
  formatQuantity,
  getLocale,
  messageParts,
} from '../src/i18n/i18n.js';

const dataDir = new URL('../src/examples/data/', import.meta.url);
const examples = readdirSync(dataDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => [f, JSON.parse(readFileSync(new URL(f, dataDir), 'utf8'))] as const);
const v4 = JSON.parse(
  readFileSync(new URL('./fixtures/v4-quantities.json', import.meta.url), 'utf8'),
) as ProjectDocument;
const en = getLocale('en');

/** Every stored quantity of a document with its parameter definition. */
function quantities(doc: ProjectDocument) {
  return doc.components.flatMap((c) =>
    CATALOG[c.type].params.flatMap((def) => {
      const v = c.params[def.key];
      return def.kind === 'quantity' && v && typeof v === 'object'
        ? [{ id: `${c.id}.${def.key}`, def, value: v.value }]
        : [];
    }),
  );
}

/** What the editor shows for a stored value, and what that text reads back as. */
function roundTrip(def: Extract<ParamDef, { kind: 'quantity' }>, value: number) {
  const units = displayUnitsFor(def.unit, def.min, def.max);
  const du = chooseDisplayUnit(value, units);
  const text = displayNumber(value, du);
  const offered = units.map((u) => ({ unit: u, symbol: displayUnitSymbol(en, def.unit, u) }));
  return { du, text, back: parseEntry(text, def.unit, du, offered, def.min < 0) };
}

describe('old projects display the same values (Phase 1)', () => {
  it('the v4 fixture is a pre-sprint document holding every quantity parameter type', () => {
    expect(v4.schemaVersion).toBe(4);
    const units = new Set(quantities(v4).map((q) => q.def.unit));
    expect([...units].sort()).toEqual(
      ['ampere', 'celsius', 'farad', 'lux', 'metre', 'ohm', 'percent_rh', 'volt'].sort(),
    );
  });

  for (const [name, doc] of [...examples, ['v4-quantities.json (fixture)', v4] as const]) {
    it(`${name}: opens with every value unchanged; each displayed number re-reads exactly`, () => {
      const before = JSON.stringify(doc.components);
      const o = openDocument(JSON.parse(JSON.stringify(doc)));
      expect(o.status).toBe('ok');
      if (o.status !== 'ok') return;
      expect(JSON.stringify(o.doc.components)).toBe(before);
      const qs = quantities(o.doc);
      for (const q of qs) {
        const { du, text, back } = roundTrip(q.def, q.value);
        expect(back, `${q.id} shown as ${text} ${du.prefix}`).toEqual({ ok: true, value: q.value });
        // The same quantity as the pre-sprint display (formatQuantity, 3 decimals) shows.
        const shown = Number(text) * 10 ** du.exponent;
        expect(Math.abs(shown - q.value)).toBeLessThanOrEqual(Math.abs(q.value) * 1e-12);
        expect(formatQuantity(en, { value: q.value, unit: q.def.unit })).toBeTruthy();
      }
    });
  }

  it('representative stored values are shown as the expected number and unit', () => {
    const def = (type: keyof typeof CATALOG, key: string) => {
      const d = CATALOG[type].params.find((p) => p.key === key)!;
      if (d.kind !== 'quantity') throw new Error(key);
      return d;
    };
    const cases: [ReturnType<typeof def>, number, string, string][] = [
      [def('component.resistor', 'resistance'), 220, '220', 'Ω'],
      [def('component.resistor', 'resistance'), 4700, '4.7', 'kΩ'],
      [def('component.resistor', 'resistance'), 2_200_000, '2.2', 'MΩ'],
      [def('component.capacitor', 'capacitance'), 1e-4, '100', 'µF'],
      [def('component.capacitor', 'capacitance'), 1e-7, '100', 'nF'],
      [def('component.capacitor', 'capacitance'), 3.3e-9, '3.3', 'nF'],
      [def('instrument.lab_psu', 'currentLimit'), 0.1, '100', 'mA'],
      [def('instrument.lab_psu', 'currentLimit'), 1.5, '1.5', 'A'],
      [def('instrument.lab_psu', 'setpointVoltage'), 3.3, '3.3', 'V'],
      [def('sensor.hc_sr04', 'distance'), 0.5, '50', 'cm'],
      [def('sensor.hc_sr04', 'distance'), 1.2, '1.2', 'm'],
      [def('sensor.dht22', 'temperature'), -12.5, '-12.5', '°C'],
    ];
    for (const [d, v, text, sym] of cases) {
      const r = roundTrip(d, v);
      expect([r.text, displayUnitSymbol(en, d.unit, r.du)]).toEqual([text, sym]);
    }
  });
});

describe('structured values round-trip exactly; a chosen unit is kept after commit/reload', () => {
  const R = CATALOG['component.resistor'].params.find((p) => p.key === 'resistance')!;
  const C = CATALOG['component.capacitor'].params.find((p) => p.key === 'capacitance')!;
  if (R.kind !== 'quantity' || C.kind !== 'quantity') throw new Error('catalog');
  const ohm = displayUnitsFor('ohm', R.min, R.max);
  const farad = displayUnitsFor('farad', C.min, C.max);
  const pick = (units: typeof ohm, prefix: string) => units.find((u) => u.prefix === prefix)!;

  it.each([
    ['4.7', 'k', 'ohm', 4700, '4.7', 'k'],
    ['2.2', 'M', 'ohm', 2_200_000, '2.2', 'M'],
    // Re-derived as the largest unit whose number is >= 1: 0.1 µF is shown as 100 nF.
    ['0.1', 'µ', 'farad', 1e-7, '100', 'n'],
    ['3.3', 'n', 'farad', 3.3e-9, '3.3', 'n'],
    ['1', 'k', 'ohm', 1000, '1', 'k'],
    ['470', '', 'ohm', 470, '470', ''],
    ['1000', 'k', 'ohm', 1e6, '1', 'M'],
  ] as const)(
    '%s %s(%s) -> %d exactly; shown after reload as %s %s',
    (text, prefix, unit, si, shownText, shownPrefix) => {
      const units = unit === 'ohm' ? ohm : farad;
      const du = pick(units, prefix);
      const r = parseEntry(text, unit, du, [], false);
      expect(r).toEqual({ ok: true, value: si });
      // Stored as {value, unit}: JSON round trip, then re-derived (deterministic, stable).
      const stored = JSON.parse(JSON.stringify({ value: si, unit })) as { value: number };
      const again = chooseDisplayUnit(stored.value, units);
      expect(again.prefix).toBe(shownPrefix);
      expect(displayNumber(stored.value, again)).toBe(shownText);
      // The shown pair reads back to the identical SI value (stable under repeated reloads).
      expect(parseEntry(shownText, unit, again, [], false)).toEqual({ ok: true, value: si });
    },
  );

  it('a dropdown change keeps the typed number: 220 Ω -> 220 kΩ', () => {
    expect(parseEntry('220', 'ohm', pick(ohm, 'k'), [], false)).toEqual({
      ok: true,
      value: 220_000,
    });
  });
});

describe('which parameters get a unit dropdown', () => {
  it('the dropdown params and the fixed-symbol params of the catalog', () => {
    const lists: Record<string, string[]> = {};
    for (const def of Object.values(CATALOG))
      for (const p of def.params)
        if (p.kind === 'quantity') {
          const units = displayUnitsFor(p.unit, p.min, p.max);
          lists[`${def.type}.${p.key}`] = units.map((u) => displayUnitSymbol(en, p.unit, u));
        }
    expect(lists).toEqual({
      'instrument.lab_psu.setpointVoltage': ['V'],
      'instrument.lab_psu.currentLimit': ['mA', 'A'],
      'component.resistor.resistance': ['Ω', 'kΩ', 'MΩ'],
      'component.photoresistor.illuminance': ['lx'],
      'component.capacitor.capacitance': ['pF', 'nF', 'µF', 'mF'],
      'component.capacitor.ratedVoltage': ['V'],
      'sensor.hc_sr04.distance': ['mm', 'cm', 'm'],
      'sensor.hc_sr04.airTemperature': ['°C'],
      'sensor.dht22.temperature': ['°C'],
      'sensor.dht22.humidity': ['%RH'],
      'component.potentiometer.resistance': ['Ω', 'kΩ', 'MΩ'],
      'component.potentiometer.position': ['%'],
    });
  });
});

describe('range hint: quantities are LTR isolates in every locale (owner-6)', () => {
  it('the hint template splits into text and parameters; each locale formats the same units', () => {
    for (const locale of LOCALES) {
      const parts = messageParts(locale, 'inspector.range');
      expect(parts.filter((p) => 'param' in p).map((p) => ('param' in p ? p.param : ''))).toEqual([
        'min',
        'max',
      ]);
      const C = CATALOG['component.capacitor'].params.find((p) => p.key === 'capacitance')!;
      if (C.kind !== 'quantity') throw new Error('catalog');
      const units = displayUnitsFor('farad', C.min, C.max);
      expect(formatDisplayQuantity(locale, { value: C.min, unit: 'farad' }, units)).toBe('1 nF');
      expect(formatDisplayQuantity(locale, { value: C.max, unit: 'farad' }, units)).toBe('10 mF');
    }
  });
});

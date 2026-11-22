/**
 * TBI-019 G1: guide data is valid, both locales are complete, the example link resolves, every
 * displayed number is computed from the engine, and the try-it step behaves as the text says.
 */
import { describe, expect, it } from 'vitest';
import { CATALOG, createSnapshot, setParam, type ProjectDocument } from '@tbi-lab/domain';
import { EngineSession, MODEL_RATINGS, TLHR5400_ANCHOR, ratingWarnings } from '@tbi-lab/engine';
import { EXAMPLES_WITH_DOCUMENTS } from '../examples/documents.js';
import { en } from '../i18n/messages.en.js';
import { he } from '../i18n/messages.he.js';
import { getLocale, messageParts } from '../i18n/i18n.js';
import { GUIDES, requiredKeys } from './catalog.js';
import { formatPower, formatResult } from '../sim/format.js';
import { evaluateGuide, formatFacts } from './facts.js';
import { SECTION_IDS } from './types.js';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
const doc = (id: string): ProjectDocument =>
  EXAMPLES_WITH_DOCUMENTS.find((e) => e.id === id)!.document;
const solve = (d: ProjectDocument) => {
  const o = new EngineSession(createSnapshot(d)).solve();
  if (!o.ok) throw new Error(JSON.stringify(o.error));
  return o;
};
const EN = getLocale('en');
const HE = getLocale('he');

describe('guide schema', () => {
  it('has the first guide, ids are unique, and only the first-release guides exist', () => {
    const ids = GUIDES.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['led-resistor', 'button', 'potentiometer']);
  });
  for (const g of GUIDES) {
    describe(g.id, () => {
      it('has sections in the fixed order, a sane duration, a catalog part and a no-runtime flag', () => {
        const order = g.sections.map((s) => SECTION_IDS.indexOf(s.id));
        expect(order).toEqual([...order].sort((a, b) => a - b));
        expect(new Set(order).size).toBe(order.length);
        for (const required of ['what', 'behaviour', 'circuit', 'tryit'] as const)
          expect(g.sections.map((s) => s.id)).toContain(required);
        expect(g.minutes).toBeGreaterThanOrEqual(2);
        expect(g.minutes).toBeLessThanOrEqual(5);
        expect(CATALOG[g.part]).toBeDefined();
        expect(g.runtime).toBe('none');
      });
      it('uses the key pattern compguide.<id>.<section>.<field>', () => {
        for (const s of g.sections)
          for (const k of s.keys) expect(k.startsWith(`compguide.${g.id}.${s.id}.`)).toBe(true);
        expect(g.titleKey).toBe(`compguide.${g.id}.title`);
      });
      it('behaviour has 3 to 5 items and the try-it section has action and expectation', () => {
        const items = g.sections
          .find((s) => s.id === 'behaviour')!
          .keys.filter((k) => k.includes('.items.'));
        expect(items.length).toBeGreaterThanOrEqual(3);
        expect(items.length).toBeLessThanOrEqual(5);
        const tryKeys = g.sections
          .find((s) => s.id === 'tryit')!
          .keys.map((k) => k.split('.').pop());
        expect(tryKeys).toEqual(['heading', 'action', 'expect']);
      });
    });
  }
});

describe('en/he key parity', () => {
  for (const g of GUIDES) {
    it(`${g.id}: every required key exists in both bundles, non-empty, same placeholders`, () => {
      for (const k of requiredKeys(g)) {
        expect(en[k], k).toBeTruthy();
        expect(he[k], k).toBeTruthy();
        expect(placeholders(he[k]), k).toEqual(placeholders(en[k]));
      }
    });
    it(`${g.id}: no compguide key is outside the guide's required set (no orphans)`, () => {
      const required = new Set<string>(GUIDES.flatMap(requiredKeys));
      for (const k of Object.keys(en))
        if (k.startsWith('compguide.')) expect(required.has(k), k).toBe(true);
      for (const k of Object.keys(he))
        if (k.startsWith('compguide.')) expect(k in en, k).toBe(true);
    });
    it(`${g.id}: Hebrew text is Hebrew and English text has no Hebrew letters`, () => {
      for (const k of requiredKeys(g)) {
        expect(en[k], k).not.toMatch(/[֐-׿]/);
        expect(he[k].replace(/\{\w+\}/g, ''), k).toMatch(/[֐-׿]/);
      }
    });
    it(`${g.id}: every placeholder has a fact and every fact is used`, () => {
      const used = new Set(requiredKeys(g).flatMap((k) => placeholders(en[k])));
      for (const p of used) expect(g.facts[p], p).toBeDefined();
      for (const f of Object.keys(g.facts)) expect(used.has(f), f).toBe(true);
    });
    it(`${g.id}: messages contain no typed number with a unit (values come from facts)`, () => {
      const typed = /\d\s?(V|mA|A|W|mW|Ω|kΩ|MΩ|cm|µs|ms|m\/s|Hz|%)/;
      for (const k of requiredKeys(g)) {
        expect(en[k].replace(/\{\w+\}/g, ''), k).not.toMatch(typed);
        expect(he[k].replace(/\{\w+\}/g, ''), k).not.toMatch(typed);
        expect(en[k].replace(/\{\w+\}/g, ''), k).not.toMatch(/\d/);
        expect(he[k].replace(/\{\w+\}/g, ''), k).not.toMatch(/\d/);
      }
    });
    it(`${g.id}: placeholders are isolated by messageParts in both locales (LTR/bdi-safe)`, () => {
      for (const k of requiredKeys(g))
        for (const loc of [EN, HE]) {
          const params = messageParts(loc, k).flatMap((p) => ('param' in p ? [p.param] : []));
          expect(params.sort(), `${loc.code} ${k}`).toEqual(placeholders(loc.messages[k]));
        }
    });
  }
});

describe('example link', () => {
  for (const g of GUIDES) {
    it(`${g.id}: example ${g.exampleId} exists, lists the part, and its document is valid`, () => {
      const ex = EXAMPLES_WITH_DOCUMENTS.find((e) => e.id === g.exampleId);
      expect(ex).toBeDefined();
      expect(ex!.parts).toContain(g.part);
      expect(ex!.document.components.some((c) => c.type === g.part)).toBe(true);
      for (const c of [
        g.tryIt.action.component,
        ...Object.values(g.facts).flatMap((f) => ('component' in f ? [f.component] : [])),
      ])
        expect(
          ex!.document.components.some((x) => x.id === c),
          c,
        ).toBe(true);
    });
  }
});

describe('values are real (computed from the engine, never typed)', () => {
  const g = GUIDES.find((x) => x.id === 'led-resistor')!;
  const before = doc('led-current');
  const ev = evaluateGuide(g, before);
  const f = (n: string) => ev.facts[n]!;

  it('every fact evaluates', () => {
    for (const [n, q] of Object.entries(ev.facts)) expect(q, n).not.toBeNull();
  });
  it('matches the independent solve of the example document', () => {
    const s = solve(before);
    expect(f('v')).toEqual({ value: s.components.D1!.voltage, unit: 'volt' });
    expect(f('i')).toEqual({ value: s.components.D1!.current, unit: 'ampere' });
    expect(f('rv')).toEqual({ value: s.components.R1!.voltage, unit: 'volt' });
    // KVL: the supply is the resistor drop plus the LED voltage.
    expect(Math.abs(f('supply').value - (f('rv').value + f('v').value))).toBeLessThan(1e-9);
    // Same operating point examples.test.ts pins (1.982 V, 13.72 mA).
    expect(f('v').value).toBeCloseTo(1.9816, 3);
    expect(f('i').value).toBeCloseTo(13.72e-3, 4);
    expect(f('r')).toEqual({ value: 220, unit: 'ohm' });
  });
  it('constants and ratings are the engine exports', () => {
    expect(f('anchorV').value).toBe(TLHR5400_ANCHOR.forwardVoltageV);
    expect(f('anchorI').value).toBe(TLHR5400_ANCHOR.forwardCurrentA);
    const r = MODEL_RATINGS['model.led.vishay_tlhr5400']!;
    expect(f('maxI').value).toBe(r.forwardCurrentA);
    expect(f('maxRev').value).toBe(r.reverseVoltageV);
    expect(f('maxP').value).toBe(r.powerW);
  });
  it('rendered text carries the formatted values in both locales', () => {
    for (const loc of [EN, HE]) {
      const shown = formatFacts(loc, ev.facts);
      expect(shown.i).toBe(formatResult(loc, f('i').value, 'ampere'));
      const text = loc.messages[g.sections[1]!.keys[1]!].replace(
        /\{(\w+)\}/g,
        (_, n: string) => shown[n]!,
      );
      expect(text).toContain(shown.v);
      expect(text).toContain(shown.i);
      expect(text).not.toMatch(/\{\w+\}/);
    }
    expect(formatFacts(EN, ev.facts).maxP).toBe(formatPower(EN, f('maxP').value));
    // The English figures are the ones the example summary quotes.
    expect(formatFacts(EN, ev.facts).r).toBe('220 Ω');
  });
  it('shows no number when a source cannot be evaluated (no typed fallback)', () => {
    const broken = { ...before, components: before.components.filter((c) => c.id !== 'D1') };
    const e2 = evaluateGuide(g, broken);
    expect(e2.facts.v).toBeNull();
    expect(e2.facts.maxI).toBeNull();
    expect('v' in formatFacts(EN, e2.facts)).toBe(false);
  });
});

describe('try-it verification (deterministic, test-side)', () => {
  const g = GUIDES.find((x) => x.id === 'led-resistor')!;
  const before = doc('led-current');
  const ev = evaluateGuide(g, before);

  it('the action applies and the displayed after-values equal an independent solve', () => {
    const a = g.tryIt.action;
    if (a.kind !== 'set-param') throw new Error('led try-it is a parameter change');
    const r = setParam(before, a.component, a.param, a.to);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = solve(r.doc);
    expect(ev.tryIt.applied).toBe(true);
    expect(ev.facts.rTry).toEqual(a.to);
    expect(ev.facts.iAfter).toEqual({ value: s.components.D1!.current, unit: 'ampere' });
  });
  it('before and after differ as the text claims: current rises above the rating, and the app warns', () => {
    expect(ev.facts.iAfter!.value).toBeGreaterThan(ev.facts.i!.value);
    expect(ev.facts.iAfter!.value).toBeGreaterThan(ev.facts.maxI!.value);
    expect(ev.tryIt.exceedsRating).toBe(true);
    expect(ev.tryIt.ratingWarned).toBe(true);
    // The unmodified example raises no rating warning (so the "after" warning is caused by the step).
    const snap = createSnapshot(before);
    expect(ratingWarnings(snap, solve(before))).toEqual([]);
  });
  it('the original document is not mutated by the evaluation', () => {
    const r1 = before.components.find((c) => c.id === 'R1')!.params.resistance;
    expect(r1).toEqual({ value: 220, unit: 'ohm' });
  });
});

describe('button guide (ideal momentary switch, verified against the engine)', () => {
  const g = GUIDES.find((x) => x.id === 'button')!;
  const before = doc('push-button');
  const ev = evaluateGuide(g, before);
  const f = (n: string) => ev.facts[n]!;

  it('every fact evaluates and the try-it is a press of the example button', () => {
    for (const [n, q] of Object.entries(ev.facts)) expect(q, n).not.toBeNull();
    expect(g.tryIt.action).toEqual({ kind: 'press', component: 'SW1' });
    expect(ev.tryIt).toMatchObject({ applied: true, solved: true });
  });
  it('open: no LED current and the whole supply across the button', () => {
    expect(f('iOff').value).toBe(0);
    expect(f('swOpenV').value).toBeCloseTo(f('supply').value, 9);
  });
  it('pressed (independent session): 0 V across the contact, LED current equals the solve', () => {
    const s = new EngineSession(createSnapshot(before));
    expect(s.setMomentary('SW1', true)).toBeNull();
    const o = s.solve();
    if (!o.ok) throw new Error('solve');
    expect(o.components.SW1!.closed).toBe(true);
    expect(f('swClosedV').value).toBe(o.components.SW1!.voltage);
    expect(f('swClosedV').value).toBe(0);
    expect(f('iOn').value).toBe(o.components.D1!.current);
    expect(f('iOn').value).toBeGreaterThan(0);
    // The press is runtime input only: the document is untouched.
    expect(before.components.find((c) => c.id === 'SW1')!.params).toEqual({});
  });
  it('the model has no rating for a switch (the limits text says none)', () => {
    expect(ratingWarnings(createSnapshot(before), solve(before))).toEqual([]);
  });
});

describe('potentiometer guide (linear divider, verified against the engine)', () => {
  const g = GUIDES.find((x) => x.id === 'potentiometer')!;
  const before = doc('pot-divider');
  const ev = evaluateGuide(g, before);
  const f = (n: string) => ev.facts[n]!;

  it('every fact evaluates', () => {
    for (const [n, q] of Object.entries(ev.facts)) expect(q, n).not.toBeNull();
    expect(ev.tryIt).toMatchObject({ applied: true, solved: true });
  });
  it('wiper voltage is the supply times the track share from A (A at GND, B at supply)', () => {
    expect(f('vWiper').value).toBeCloseTo((f('supply').value * f('pos').value) / 100, 9);
    expect(f('vWiperAfter').value).toBeCloseTo((f('supply').value * f('posTry').value) / 100, 9);
    expect(f('vWiperAfter').value).toBeLessThan(f('vWiper').value);
  });
  it('the after value equals an independent solve of the changed document', () => {
    const a = g.tryIt.action;
    if (a.kind !== 'set-param') throw new Error('set-param expected');
    const r = setParam(before, a.component, a.param, a.to);
    if (!r.ok) throw new Error('setParam');
    expect(f('vWiperAfter').value).toBe(solve(r.doc).components.RV1!.terminals.wiper);
    expect(f('posTry')).toEqual(a.to);
  });
  it('the dimmer example uses the part as a rheostat (one end and the wiper wired)', () => {
    const loaded = doc('pot-led-dimmer');
    const o = solve(loaded);
    // In the dimmer example the pot is a rheostat: only one end and the wiper are wired.
    const pot = loaded.components.find((c) => c.type === 'component.potentiometer')!;
    const used = loaded.connections.filter((c) => c.component === pot.id).map((c) => c.terminal);
    expect(used.sort()).toEqual(['b', 'wiper']);
    expect(o.components[pot.id]).toBeDefined();
  });
  it('formats in both locales (percent and volts)', () => {
    expect(formatFacts(EN, ev.facts).pos).toBe('50 %');
    expect(formatFacts(HE, ev.facts).vWiper).toBe(formatResult(HE, 2.5, 'volt'));
  });
});

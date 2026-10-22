/**
 * A8: the UI is complete in every locale with no missing key and no hard-coded string.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { CATALOG } from '@tbi-lab/domain';
import { en } from '../src/i18n/messages.en.js';
import { GLOSSARY, GLOSSARY_TERMS, applyGlossary } from '../src/i18n/glossary.js';
import {
  LOCALES,
  formatQuantity,
  getLocale,
  inputForm,
  isMessageKey,
  isolateLtr,
  negotiateLocale,
  translate,
} from '../src/i18n/i18n.js';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('locale bundles', () => {
  for (const locale of LOCALES) {
    it(`${locale.code}: has exactly the reference key set, every message non-empty`, () => {
      expect(Object.keys(locale.messages).sort()).toEqual(Object.keys(en).sort());
      for (const [key, value] of Object.entries(locale.messages)) {
        expect(value.trim(), key).not.toBe('');
      }
    });
    it(`${locale.code}: every message keeps the reference placeholders`, () => {
      for (const [key, value] of Object.entries(en)) {
        expect(placeholders(locale.messages[key as keyof typeof en]), key).toEqual(
          placeholders(value),
        );
      }
    });
  }

  it('the Hebrew bundle is actually Hebrew, not a copy of English', () => {
    const he = getLocale('he').messages;
    const same = Object.keys(en).filter(
      (k) => he[k as keyof typeof en] === en[k as keyof typeof en],
    );
    // Technical tokens kept verbatim in every locale (terminology rule, Sprint 6): board pin
    // silkscreen names (IO34, VP, GND) and the digital logic levels HIGH / LOW.
    const technical = (k: string) => k.startsWith('pin.') || k.startsWith('mcu.level.');
    for (const k of same.filter(technical))
      expect(en[k as keyof typeof en], k).toMatch(/^[A-Z][A-Z0-9]*$/);
    // Sprint 12: I2C addresses are hex tokens (0x27), the same in every locale.
    const address = (k: string) => k.startsWith('i2c.');
    for (const k of same.filter(address))
      expect(en[k as keyof typeof en], k).toMatch(/^0x[0-9a-f]{2}$/);
    // Only language-neutral messages may be identical (unit symbols, the reference-and-type pattern).
    // CV and CC stay as professional technical terms in Hebrew (product scope §12).
    expect(same.filter((k) => !technical(k) && !address(k)).sort()).toEqual([
      // Sprint 10: RGB channel letters (R, G, B) are technical tokens, like pin names.
      'canvas.componentLabel',
      // Sprint 13: a product name, used as-is in Hebrew.
      'capabilities.facility.bluetooth.name',
      // Sprint 15: a PWM pad's waveform (only placeholders and the PWM token) and a product name.
      'mcu.pwm.wave',
      'model.servo.sg90',
      'probe.currentLabel',
      'probe.noValue',
      'probe.voltageLabel',
      // Sprint 19B: programming-language names (product names, as in every locale).
      'program.language.arduino-cpp',
      'program.language.micropython',
      'rating.channel',
      'sim.badge.cc',
      'sim.badge.cv',
      'sim.part.short.base',
      'sim.part.short.blue',
      'sim.part.short.collector',
      'sim.part.short.emitter',
      'sim.part.short.green',
      'sim.part.short.red',
      // Sprint 19B: logic levels and gate input letters are technical tokens (as HIGH / LOW).
      'sim.part.state.firstUnknownInput.a',
      'sim.part.state.firstUnknownInput.b',
      'sim.part.state.gateOutput.high',
      'sim.part.state.gateOutput.low',
      'sim.part.state.input_a.high',
      'sim.part.state.input_a.low',
      'sim.part.state.input_b.high',
      'sim.part.state.input_b.low',
      'sim.part.state.output.low',
      'sim.time',
      'unit.ampere.symbol',
      'unit.celsius.symbol',
      'unit.degree.symbol',
      'unit.farad.symbol',
      'unit.hertz.symbol',
      'unit.lux.symbol',
      'unit.metre.symbol',
      'unit.ohm.symbol',
      'unit.percent.symbol',
      'unit.percent_rh.symbol',
      'unit.second.symbol',
      'unit.volt.symbol',
      'unit.watt.symbol',
      // Sprint 10: "Commit" is the professional term for the build identity (version details).
      'version.commit',
    ]);
  });

  it('every catalog translation key exists (names, terminals, parameters)', () => {
    for (const def of Object.values(CATALOG)) {
      const keys = [
        def.nameKey,
        ...def.terminals.map((t) => t.labelKey),
        ...def.params.map((p) => p.labelKey),
      ];
      for (const key of keys) expect(isMessageKey(key), key).toBe(true);
    }
  });

  it('declares a direction per locale and supports N locales, not a hard-coded pair', () => {
    expect(getLocale('he').dir).toBe('rtl');
    expect(getLocale('en').dir).toBe('ltr');
    expect(getLocale('xx').code).toBe('en');
    expect(negotiateLocale(['he-IL', 'en-US'])).toBe('he');
    expect(negotiateLocale(['de-DE', 'en-GB'])).toBe('en');
    expect(negotiateLocale(['fr'])).toBe('en');
  });
});

describe('electrical glossary', () => {
  it('adopts the PM-approved Hebrew V1 terms', () => {
    expect(GLOSSARY.he).toMatchObject({
      ground: 'אדמה (GND)',
      net: 'רשת',
      terminal: 'הדק',
      junction: 'צומת',
      component: 'רכיב',
      pin: 'פין',
    });
  });
  it('defines every term in every locale', () => {
    for (const locale of LOCALES) {
      expect(Object.keys(GLOSSARY[locale.code]!).sort()).toEqual([...GLOSSARY_TERMS].sort());
    }
  });
  it('never uses protective-earth wording for circuit ground', () => {
    const he = getLocale('he').messages;
    for (const [key, text] of Object.entries(he)) expect(text, key).not.toContain('הארקה');
    expect(he['component.component.ground.name']).toBe('אדמה (GND)');
  });
  it('resolves every [[term]] reference in the bundles', () => {
    for (const locale of LOCALES) {
      for (const [key, text] of Object.entries(locale.messages))
        expect(text, key).not.toMatch(/\[\[/);
    }
    expect(() => applyGlossary({ k: '[[nope]]' }, GLOSSARY.en!)).toThrow(/nope/);
  });
});

describe('formatting', () => {
  it('formats values per locale without changing them', () => {
    for (const locale of LOCALES) {
      expect(formatQuantity(locale, { value: 4700, unit: 'ohm' })).toBe('4.7 kΩ');
      expect(formatQuantity(locale, { value: 0.1, unit: 'ampere' })).toBe('100 mA');
      expect(formatQuantity(locale, { value: 3.3, unit: 'volt' })).toBe('3.3 V');
    }
  });
  it('produces a locale-independent input form', () => {
    expect(inputForm(4700)).toBe('4.7k');
    expect(inputForm(220)).toBe('220');
    expect(inputForm(0.00025)).toBe('250u');
  });
  it('shows temperature and relative humidity without SI prefixes (Sprint 12)', () => {
    for (const locale of LOCALES) {
      expect(formatQuantity(locale, { value: 21.5, unit: 'celsius' })).toBe('21.5 °C');
      expect(formatQuantity(locale, { value: 55, unit: 'percent_rh' })).toBe('55 %RH');
      // A distance keeps its prefix: 0.5 m reads as 500 mm.
      expect(formatQuantity(locale, { value: 0.5, unit: 'metre' })).toBe('500 mm');
    }
    expect(formatQuantity(getLocale('en'), { value: 0.5, unit: 'celsius' })).toBe('0.5 °C');
    expect(inputForm(0.5, 'celsius')).toBe('0.5');
    expect(inputForm(-12.5, 'celsius')).toBe('-12.5');
    // Sprint 13 OS-06: `500m` beside the unit `m` read as "500 m m"; a metre field is edited as
    // the plain decimal in metres (the display keeps `500 mm`).
    expect(inputForm(0.5, 'metre')).toBe('0.5');
    expect(inputForm(0.03, 'metre')).toBe('0.03');
  });
  it('labels the I2C address options with the address itself in every locale', () => {
    const lcd = CATALOG['display.lcd1602_i2c'].params.find((p) => p.key === 'address')!;
    expect(lcd.kind).toBe('enum');
    if (lcd.kind !== 'enum') return;
    for (const locale of LOCALES)
      for (const o of lcd.options) {
        expect(isMessageKey(o.labelKey), o.labelKey).toBe(true);
        expect(translate(locale, o.labelKey as keyof typeof en)).toBe(o.value.slice('i2c.'.length));
      }
  });
  it('isolates LTR technical values inside translated sentences', () => {
    const s = translate(getLocale('he'), 'error.range', {
      min: isolateLtr('1 mΩ'),
      max: isolateLtr('1 GΩ'),
    });
    expect(s).toContain('⁦1 mΩ⁩');
  });
});

const TEXT_ATTRS = new Set(['aria-label', 'title', 'placeholder', 'alt', 'label']);
const hasLetters = (s: string) => /\p{L}/u.test(s);

/** User-facing literals in TSX: JSX text, text attributes and string-literal children. */
function hardCodedStrings(source: string): string[] {
  const sf = ts.createSourceFile('x.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node) && hasLetters(node.text)) violations.push(`text: ${node.text.trim()}`);
    if (ts.isJsxAttribute(node) && TEXT_ATTRS.has(node.name.getText()) && node.initializer) {
      if (ts.isStringLiteral(node.initializer) && hasLetters(node.initializer.text)) {
        violations.push(`${node.name.getText()}="${node.initializer.text}"`);
      }
    }
    if (
      ts.isJsxExpression(node) &&
      node.expression &&
      ts.isStringLiteral(node.expression) &&
      hasLetters(node.expression.text)
    ) {
      violations.push(`{'${node.expression.text}'}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

describe('no hard-coded user-facing strings in product UI code', () => {
  it('the scanner catches each form of hard-coded text', () => {
    expect(hardCodedStrings(`const a = <p>Hello</p>;`)).toEqual(['text: Hello']);
    expect(hardCodedStrings(`const a = <b aria-label="Close" />;`)).toEqual(['aria-label="Close"']);
    expect(hardCodedStrings(`const a = <p>{'שלום'}</p>;`)).toEqual(["{'שלום'}"]);
    expect(hardCodedStrings(`const a = <p>{t('ok')} + −</p>;`)).toEqual([]);
  });

  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.tsx')) files.push(p);
    }
  };
  walk(fileURLToPath(new URL('../src', import.meta.url)));
  it('scans at least the main UI files', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  for (const file of files) {
    it(file.split('/src/')[1]!, () => {
      expect(hardCodedStrings(readFileSync(file, 'utf8'))).toEqual([]);
    });
  }
});

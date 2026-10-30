/**
 * OS-12: example search and categories (app/src/examples/discover.ts). Expectations come from the
 * example DOCUMENTS where possible (an alias finds exactly the examples whose circuit has the
 * part), so the search cannot drift from what the examples contain.
 */
import { describe, expect, it } from 'vitest';
import type { ComponentTypeId } from '@tbi-lab/domain';
import { EXAMPLES } from '../src/examples/catalog.js';
import { EXAMPLES_WITH_DOCUMENTS } from '../src/examples/documents.js';
import {
  availableCategories,
  buildExampleIndex,
  categoriesOf,
  matchExamples,
  type ExampleCategory,
} from '../src/examples/discover.js';
import { LOCALES, translate } from '../src/i18n/i18n.js';

const index = buildExampleIndex();
const ids = (q: string, cats: ExampleCategory[] = []) =>
  matchExamples(index, q, new Set(cats))
    .map((e) => e.id)
    .sort();
const withPart = (...types: ComponentTypeId[]) =>
  EXAMPLES_WITH_DOCUMENTS.filter((e) =>
    e.document.components.some((c) => types.includes(c.type as ComponentTypeId)),
  )
    .map((e) => e.id)
    .sort();
const ALL = EXAMPLES.map((e) => e.id).sort();

describe('catalog metadata', () => {
  it('each example lists exactly the part types of its document (ground excluded)', () => {
    for (const e of EXAMPLES_WITH_DOCUMENTS) {
      const fromDoc = [...new Set(e.document.components.map((c) => c.type))]
        .filter((t) => t !== 'component.ground')
        .sort();
      expect([...e.parts].sort(), e.id).toEqual(fromDoc);
    }
  });
});

describe('categories', () => {
  it('every example has at least one category; every offered category has examples', () => {
    for (const e of EXAMPLES) expect(categoriesOf(e).length, e.id).toBeGreaterThan(0);
    const offered = availableCategories(index);
    for (const c of offered) expect(c.count).toBeGreaterThan(0);
    expect(offered.map((c) => c.id)).toEqual([
      'basic',
      'sensors',
      'lighting',
      'controllers',
      'switching',
      'logic',
    ]);
  });

  it('are derived from parts, not titles', () => {
    expect(ids('', ['controllers'])).toEqual(withPart('board.esp32_devkitc_wroom32'));
    expect(ids('', ['sensors'])).toEqual(
      withPart('component.photoresistor', 'sensor.pir_hc_sr501', 'sensor.hc_sr04', 'sensor.dht22'),
    );
    // Basic: only supply, passives, LEDs and switches; never a board, sensor or display.
    for (const id of ids('', ['basic']))
      expect(
        withPart('board.esp32_devkitc_wroom32', 'display.lcd1602_i2c', 'sensor.dht22'),
      ).not.toContain(id);
    expect(ids('', ['basic'])).toContain('ohms-law');
  });

  it('combine with OR among themselves (no example hidden by adding a category)', () => {
    const s = ids('', ['sensors']);
    const c = ids('', ['controllers']);
    expect(ids('', ['sensors', 'controllers'])).toEqual([...new Set([...s, ...c])].sort());
    // Every example is in the union of all categories.
    expect(ids('', ['basic', 'sensors', 'lighting', 'controllers', 'switching'])).toEqual(ALL);
  });
});

describe('search', () => {
  it('no query and no category: every example', () => {
    expect(ids('')).toEqual(ALL);
    expect(ids('   ')).toEqual(ALL);
  });

  it('technical aliases find exactly the examples with that part', () => {
    expect(ids('LDR')).toEqual(withPart('component.photoresistor'));
    expect(ids('PIR')).toEqual(withPart('sensor.pir_hc_sr501'));
    expect(ids('I2C')).toEqual(withPart('display.lcd1602_i2c'));
    expect(ids('HC-SR04')).toEqual(withPart('sensor.hc_sr04'));
    expect(ids('hcsr04')).toEqual(withPart('sensor.hc_sr04')); // punctuation-insensitive
    expect(ids('dht22')).toEqual(withPart('sensor.dht22'));
    expect(ids('ESP32')).toEqual(withPart('board.esp32_devkitc_wroom32'));
    expect(ids('esp32')).toEqual(ids('ESP32'));
  });

  it('several words must all match', () => {
    // Sprint 24: the MicroPython LCD example runs on the same ESP32 + LCD circuit.
    expect(ids('ESP32 LCD')).toEqual(['esp32-lcd-hello', 'mpy-lcd-hello']);
    expect(ids('LCD ESP32')).toEqual(['esp32-lcd-hello', 'mpy-lcd-hello']);
    expect(ids('MicroPython LCD')).toEqual(['mpy-lcd-hello']);
    expect(ids('ESP32 PIR')).toEqual(['esp32-motion-relay']);
    expect(ids('relay ESP32')).toEqual(
      withPart('component.relay').filter((id) =>
        withPart('board.esp32_devkitc_wroom32').includes(id),
      ),
    );
  });

  it('Hebrew and English queries work whatever the interface language', () => {
    // The index covers every locale, so these are independent of the UI language.
    expect(ids('ממסר')).toEqual(withPart('component.relay'));
    expect(ids('relay')).toEqual(withPart('component.relay'));
    expect(ids('הממסר')).toEqual(ids('ממסר')); // one Hebrew prefix letter
    // Final letter forms: the singular "חיישן" (final nun) finds every sensor example, also those
    // whose texts only say "חיישנים" (regular nun). Found by the OS-12 visual check: 6 of 7.
    expect(ids('חיישן')).toEqual(ids('', ['sensors']));
    expect(ids('ESP32 צג')).toEqual(['esp32-lcd-hello', 'mpy-lcd-hello']); // mixed scripts
  });

  it('category words are searchable too, in every locale', () => {
    expect(ids('sensors')).toEqual(ids('', ['sensors']));
    expect(ids('חיישנים')).toEqual(ids('', ['sensors']));
  });

  it('words and categories combine (AND)', () => {
    expect(ids('LED', ['controllers'])).toEqual(
      ids('LED').filter((id) => ids('', ['controllers']).includes(id)),
    );
  });

  it('an impossible query gives nothing (the empty state)', () => {
    expect(ids('zzqqxx')).toEqual([]);
    expect(ids('ESP32', ['basic'])).toEqual([]);
  });

  it('every example is discoverable by its own title in every locale', () => {
    for (const e of EXAMPLES)
      for (const l of LOCALES)
        expect(ids(translate(l, e.titleKey)), `${e.id} ${l.code}`).toContain(e.id);
  });

  it('is deterministic', () => {
    expect(ids('LED sensor')).toEqual(ids('LED sensor'));
    expect(buildExampleIndex()).toEqual(index);
  });
});

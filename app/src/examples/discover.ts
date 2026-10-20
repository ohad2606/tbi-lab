/**
 * OS-12: finding an example on the Projects screen. Deterministic, local, instant: no service.
 *
 * Categories come from the PARTS an example's circuit uses (a rule per part type, below), never
 * from its title, so a new example is classified by what it contains. Only categories that at
 * least one example has are offered. There is deliberately no "communication / IoT" category: the
 * simulator has no networking, and the label would promise what it cannot do (I2C, the sensors'
 * protocols and the ESP32 stay findable by search).
 *
 * Search matches every query word (AND) against, in EVERY supported locale (not only the current
 * UI language): the example's title and summary, the localized names of its parts, the part
 * aliases from the domain catalog (LDR, PIR, I2C, HC-SR04, ESP32, PCF8574...) and its category
 * names. Matching is case-, accent- and punctuation-insensitive ("hcsr04" finds HC-SR04), by
 * substring; Hebrew final letter forms match their regular forms, and a Hebrew word may carry
 * one prefix letter (ה, ו, ב, ל, מ, ש, כ). Categories combine
 * with OR among themselves and AND with the words.
 */
import { CATALOG, type ComponentTypeId } from '@tbi-lab/domain';
import { catalogText, LOCALES, translate, type LocaleInfo } from '../i18n/i18n.js';
import type { MessageKey } from '../i18n/messages.en.js';
import { EXAMPLES, type Example } from './catalog.js';

export type ExampleCategory =
  'basic' | 'sensors' | 'lighting' | 'controllers' | 'switching' | 'logic';

/** In display order. */
export const EXAMPLE_CATEGORIES: readonly { id: ExampleCategory; labelKey: MessageKey }[] = [
  { id: 'basic', labelKey: 'library.examples.category.basic' },
  { id: 'sensors', labelKey: 'library.examples.category.sensors' },
  { id: 'lighting', labelKey: 'library.examples.category.lighting' },
  { id: 'controllers', labelKey: 'library.examples.category.controllers' },
  { id: 'switching', labelKey: 'library.examples.category.switching' },
  { id: 'logic', labelKey: 'library.examples.category.logic' },
];

/**
 * What each part type contributes. Exhaustive over the catalog (the type makes a new part
 * impossible to forget). `basic`: an example made ONLY of basic parts is a basic circuit.
 */
const PART_RULES: Record<ComponentTypeId, { categories: ExampleCategory[]; basic: boolean }> = {
  'instrument.lab_psu': { categories: [], basic: true },
  'component.ground': { categories: [], basic: true },
  'component.resistor': { categories: [], basic: true },
  'component.diode': { categories: [], basic: true },
  'component.capacitor': { categories: [], basic: true },
  'component.led': { categories: ['lighting'], basic: true },
  'component.rgb_led': { categories: ['lighting'], basic: true },
  'component.push_button': { categories: ['switching'], basic: true },
  'component.toggle_switch': { categories: ['switching'], basic: true },
  'component.buzzer': { categories: [], basic: false },
  'component.bjt_npn': { categories: ['switching'], basic: false },
  'component.relay': { categories: ['switching'], basic: false },
  'component.photoresistor': { categories: ['sensors'], basic: false },
  'sensor.pir_hc_sr501': { categories: ['sensors'], basic: false },
  'sensor.hc_sr04': { categories: ['sensors'], basic: false },
  'sensor.dht22': { categories: ['sensors'], basic: false },
  'display.lcd1602_i2c': { categories: ['lighting'], basic: false },
  'display.led_matrix_8x8': { categories: ['lighting'], basic: false },
  'component.servo_sg90': { categories: [], basic: false },
  'logic.gate_and': { categories: ['logic'], basic: false },
  'logic.gate_nand': { categories: ['logic'], basic: false },
  'logic.gate_or': { categories: ['logic'], basic: false },
  'logic.gate_not': { categories: ['logic'], basic: false },
  'board.esp32_devkitc_wroom32': { categories: ['controllers'], basic: false },
};

export function categoriesOf(example: Pick<Example, 'parts'>): ExampleCategory[] {
  const found = new Set<ExampleCategory>();
  for (const p of example.parts) for (const c of PART_RULES[p].categories) found.add(c);
  if (example.parts.every((p) => PART_RULES[p].basic)) found.add('basic');
  return EXAMPLE_CATEGORIES.map((c) => c.id).filter((c) => found.has(c));
}

/** Hebrew final letter forms -> their regular forms (a word's end is not always its end: "חיישן" in "חיישנים"). */
const HEBREW_FINALS: Record<string, string> = { ך: 'כ', ם: 'מ', ן: 'נ', ף: 'פ', ץ: 'צ' };

/**
 * Lower case, no accents or niqqud, Hebrew final forms unified, letters and digits only (bidi
 * marks and punctuation go).
 */
export function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[ךםןףץ]/g, (c) => HEBREW_FINALS[c]!)
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export interface IndexedExample {
  example: Example;
  categories: ExampleCategory[];
  /** Normalized searchable texts, all locales. */
  fields: string[];
}

export function buildExampleIndex(
  examples: readonly Example[] = EXAMPLES,
  locales: readonly LocaleInfo[] = LOCALES,
): IndexedExample[] {
  return examples.map((example) => {
    const categories = categoriesOf(example);
    const texts: string[] = [];
    for (const l of locales) {
      texts.push(translate(l, example.titleKey), translate(l, example.summaryKey));
      for (const p of example.parts) texts.push(catalogText(l, CATALOG[p].nameKey));
      for (const c of categories)
        texts.push(translate(l, EXAMPLE_CATEGORIES.find((x) => x.id === c)!.labelKey));
    }
    for (const p of example.parts) texts.push(...CATALOG[p].aliases);
    // Words separately as well as whole texts: a query word then matches inside one text only.
    const fields = new Set<string>();
    for (const t of texts) {
      fields.add(normalize(t));
      for (const w of t.split(/\s+/)) if (w) fields.add(normalize(w));
    }
    fields.delete('');
    return { example, categories, fields: [...fields] };
  });
}

const HEBREW_PREFIX = /^[והבלמשכ](\p{Script=Hebrew}{3,})$/u;

function wordMatches(fields: readonly string[], word: string): boolean {
  if (fields.some((f) => f.includes(word))) return true;
  const bare = HEBREW_PREFIX.exec(word)?.[1];
  return bare !== undefined && fields.some((f) => f.includes(bare));
}

/** The query's words, normalized (empty words dropped). */
export function queryWords(query: string): string[] {
  return query
    .split(/\s+/)
    .map(normalize)
    .filter((w) => w.length > 0);
}

export function matchExamples(
  index: readonly IndexedExample[],
  query: string,
  categories: ReadonlySet<ExampleCategory>,
): Example[] {
  const words = queryWords(query);
  return index
    .filter(
      (e) =>
        (categories.size === 0 || e.categories.some((c) => categories.has(c))) &&
        words.every((w) => wordMatches(e.fields, w)),
    )
    .map((e) => e.example);
}

/** The categories at least one example has, in display order, with their example counts. */
export function availableCategories(
  index: readonly IndexedExample[],
): { id: ExampleCategory; labelKey: MessageKey; count: number }[] {
  return EXAMPLE_CATEGORIES.map((c) => ({
    ...c,
    count: index.filter((e) => e.categories.includes(c.id)).length,
  })).filter((c) => c.count > 0);
}

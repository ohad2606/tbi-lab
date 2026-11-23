/**
 * The component guides (TBI-019). Structure and sources only: no user-visible text and no
 * typed numbers here (texts are `compguide.*` keys; values come from facts.ts sources).
 * First release set (owner, 2026-11-22): LED and resistor, button, potentiometer.
 */
import type { MessageKey } from '../i18n/messages.en.js';
import type { ComponentGuide, GuideSection, SectionId } from './types.js';

const key = (id: string, rest: string): MessageKey => `compguide.${id}.${rest}` as MessageKey;

function section(id: string, sid: SectionId, fields: string[]): GuideSection {
  return { id: sid, keys: fields.map((f) => key(id, `${sid}.${f}`)) };
}

const LED_RESISTOR = 'led-resistor';

export const GUIDES: readonly ComponentGuide[] = [
  {
    id: LED_RESISTOR,
    part: 'component.led',
    titleKey: key(LED_RESISTOR, 'title'),
    minutes: 3,
    exampleId: 'led-current',
    runtime: 'none',
    sections: [
      section(LED_RESISTOR, 'what', ['heading', 'body']),
      section(LED_RESISTOR, 'behaviour', ['heading', 'items.1', 'items.2', 'items.3', 'items.4']),
      section(LED_RESISTOR, 'circuit', ['heading', 'body']),
      section(LED_RESISTOR, 'tryit', ['heading', 'action', 'expect']),
      section(LED_RESISTOR, 'limits', ['heading', 'body']),
    ],
    facts: {
      supply: { kind: 'param', component: 'PSU1', param: 'setpointVoltage' },
      r: { kind: 'param', component: 'R1', param: 'resistance' },
      v: { kind: 'solve', component: 'D1', field: 'voltage' },
      i: { kind: 'solve', component: 'D1', field: 'current' },
      rv: { kind: 'solve', component: 'R1', field: 'voltage' },
      anchorV: { kind: 'constant', ref: 'led.anchor.forwardV' },
      anchorI: { kind: 'constant', ref: 'led.anchor.forwardI' },
      maxI: { kind: 'rating', component: 'D1', field: 'forwardCurrentA' },
      maxRev: { kind: 'rating', component: 'D1', field: 'reverseVoltageV' },
      maxP: { kind: 'rating', component: 'D1', field: 'powerW' },
      rTry: { kind: 'param', component: 'R1', param: 'resistance', state: 'after' },
      iAfter: { kind: 'solve', component: 'D1', field: 'current', state: 'after' },
    },
    tryIt: {
      action: {
        kind: 'set-param',
        component: 'R1',
        param: 'resistance',
        to: { value: 47, unit: 'ohm' },
      },
      expect: { fact: 'iAfter', exceedsFact: 'maxI' },
    },
  },
];

export function guideById(id: string): ComponentGuide | undefined {
  return GUIDES.find((g) => g.id === id);
}

/** Guides whose main part is `part` (the Inspector link). */
export function guidesForPart(part: string): ComponentGuide[] {
  return GUIDES.filter((g) => g.part === part);
}

/** Every key a guide needs (title plus all section keys). */
export function requiredKeys(guide: ComponentGuide): MessageKey[] {
  return [guide.titleKey, ...guide.sections.flatMap((s) => s.keys)];
}

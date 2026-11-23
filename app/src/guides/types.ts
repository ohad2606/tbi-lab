/**
 * TBI-019 component guides: the data shapes. A guide is structure only; every sentence is a
 * message key (`compguide.<id>.<section>.<field>`) and every number is a named fact whose
 * single source is the engine, the domain or the example's solved circuit (never typed text).
 */
import type { ComponentTypeId, Quantity } from '@tbi-lab/domain';
import type { MessageKey } from '../i18n/messages.en.js';

export const SECTION_IDS = ['what', 'behaviour', 'circuit', 'tryit', 'limits'] as const;
export type SectionId = (typeof SECTION_IDS)[number];

/** Which circuit the fact reads: the example as shipped, or after the try-it action. */
export type FactState = 'before' | 'after';

/** Engine/domain constants a guide may quote. Resolved in facts.ts from the real exports. */
export type ConstantRef = 'led.anchor.forwardV' | 'led.anchor.forwardI';

export type FactSource =
  /** An exported engine/domain constant. */
  | { kind: 'constant'; ref: ConstantRef }
  /** A parameter of a component in the example document (or the value the try-it sets). */
  | { kind: 'param'; component: string; param: string; state?: FactState }
  /** A solved figure of a component. */
  | { kind: 'solve'; component: string; field: 'current' | 'voltage'; state?: FactState }
  /** A solved terminal potential (relative to GND), e.g. a potentiometer's wiper. */
  | { kind: 'terminal'; component: string; terminal: string; state?: FactState }
  /** An absolute maximum rating of the model the component uses (MODEL_RATINGS). */
  | { kind: 'rating'; component: string; field: 'forwardCurrentA' | 'reverseVoltageV' | 'powerW' };

export interface GuideSection {
  id: SectionId;
  /** Every message key the section needs, in reading order. */
  keys: MessageKey[];
  /** Optional sections (only `limits`) may be absent. */
}

export interface TryIt {
  action:
    | { kind: 'set-param'; component: string; param: string; to: Quantity }
    /** Hold a momentary push button while the circuit runs (runtime input, never saved). */
    | { kind: 'press'; component: string };
  /** The fact shown as the expected result (after state), and the rating it is compared with. */
  expect: { fact: string; exceedsFact?: string };
}

export interface ComponentGuide {
  id: string;
  part: ComponentTypeId;
  titleKey: MessageKey;
  /** "about N minutes"; tested range 2..5. */
  minutes: number;
  /** MUST exist in EXAMPLES; the guide never owns circuit data. */
  exampleId: string;
  runtime: 'none' | 'esp32';
  sections: GuideSection[];
  facts: Record<string, FactSource>;
  tryIt: TryIt;
}

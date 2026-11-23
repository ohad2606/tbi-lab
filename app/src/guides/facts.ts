/**
 * Fact evaluators for component guides: every number a guide shows is computed here from the
 * production engine and the example's own document. If a source cannot be evaluated the fact
 * is `null` and the guide shows no number for it (never a typed fallback).
 */
import { createSnapshot, setParam, type ProjectDocument, type UnitId } from '@tbi-lab/domain';
import {
  EngineSession,
  MODEL_RATINGS,
  TLHR5400_ANCHOR,
  ratingWarnings,
  type SolveSuccess,
} from '@tbi-lab/engine';
import type { LocaleInfo } from '../i18n/i18n.js';
import { formatPower, formatResult } from '../sim/format.js';
import type { ComponentGuide, ConstantRef, FactSource, FactState } from './types.js';

const CONSTANTS: Record<ConstantRef, FactValue> = {
  'led.anchor.forwardV': { value: TLHR5400_ANCHOR.forwardVoltageV, unit: 'volt' },
  'led.anchor.forwardI': { value: TLHR5400_ANCHOR.forwardCurrentA, unit: 'ampere' },
};

/** A guide value: a domain quantity, or a power (watts are derived, not a stored UnitId). */
export interface FactValue {
  value: number;
  unit: UnitId | 'watt';
}

const RATING_UNIT: Record<'forwardCurrentA' | 'reverseVoltageV' | 'powerW', FactValue['unit']> = {
  forwardCurrentA: 'ampere',
  reverseVoltageV: 'volt',
  powerW: 'watt',
};

export interface TryItEvaluation {
  /** The action could be applied to the example document. */
  applied: boolean;
  /** The "after" solve succeeded. */
  solved: boolean;
  /** The expected fact (after state) exceeds the named rating, and the engine warns about it. */
  exceedsRating: boolean | null;
  /** The app's over-stress warnings were produced for the after state. */
  ratingWarned: boolean;
}

export interface GuideEvaluation {
  facts: Record<string, FactValue | null>;
  tryIt: TryItEvaluation;
}

function solve(
  doc: ProjectDocument | null,
  pressed?: string,
): { snapshot: ReturnType<typeof createSnapshot>; out: SolveSuccess } | null {
  if (!doc) return null;
  const snapshot = createSnapshot(doc);
  const session = new EngineSession(snapshot);
  if (pressed !== undefined && session.setMomentary(pressed, true) !== null) return null;
  const out = session.solve();
  return out.ok ? { snapshot, out } : null;
}

/** The document after the try-it action (a press leaves the document unchanged). */
function applyAction(guide: ComponentGuide, doc: ProjectDocument): ProjectDocument | null {
  const a = guide.tryIt.action;
  if (a.kind === 'press') return doc.components.some((c) => c.id === a.component) ? doc : null;
  const r = setParam(doc, a.component, a.param, a.to);
  return r.ok ? r.doc : null;
}

function paramQuantity(doc: ProjectDocument | null, component: string, param: string) {
  const v = doc?.components.find((c) => c.id === component)?.params[param];
  return v && typeof v === 'object' && 'value' in v ? { value: v.value, unit: v.unit } : null;
}

/** Evaluate every fact of a guide against the example's document (the real engine, no cache). */
export function evaluateGuide(guide: ComponentGuide, before: ProjectDocument): GuideEvaluation {
  const after = applyAction(guide, before);
  const docs: Record<FactState, ProjectDocument | null> = { before, after };
  const solved: Record<FactState, ReturnType<typeof solve>> = {
    before: solve(before),
    after: solve(
      after,
      guide.tryIt.action.kind === 'press' ? guide.tryIt.action.component : undefined,
    ),
  };
  const read = (src: FactSource): FactValue | null => {
    if (src.kind === 'constant') return CONSTANTS[src.ref];
    if (src.kind === 'rating') {
      const model = before.components.find((c) => c.id === src.component)?.params.model;
      const r = typeof model === 'string' ? MODEL_RATINGS[model] : undefined;
      return r ? { value: r[src.field], unit: RATING_UNIT[src.field] } : null;
    }
    const state = src.state ?? 'before';
    if (src.kind === 'terminal') {
      const p = solved[state]?.out.components[src.component]?.terminals[src.terminal];
      return typeof p === 'number' && Number.isFinite(p) ? { value: p, unit: 'volt' } : null;
    }
    if (src.kind === 'param') return paramQuantity(docs[state], src.component, src.param);
    const c = solved[state]?.out.components[src.component];
    const value = c?.[src.field];
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return { value, unit: src.field === 'current' ? 'ampere' : 'volt' };
  };
  const facts: Record<string, FactValue | null> = {};
  for (const [name, src] of Object.entries(guide.facts)) facts[name] = read(src);

  const exp = guide.tryIt.expect;
  const got = facts[exp.fact];
  const limit = exp.exceedsFact ? facts[exp.exceedsFact] : null;
  const a = solved.after;
  const warned = a ? ratingWarnings(a.snapshot, a.out).length > 0 : false;
  return {
    facts,
    tryIt: {
      applied: after !== null,
      solved: a !== null,
      exceedsRating: got && limit ? got.value > limit.value : null,
      ratingWarned: warned,
    },
  };
}

/** Formatted values for message placeholders; facts that could not be evaluated are omitted. */
export function formatFacts(
  locale: LocaleInfo,
  facts: Record<string, FactValue | null>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, q] of Object.entries(facts))
    if (q)
      out[name] =
        q.unit === 'watt' ? formatPower(locale, q.value) : formatResult(locale, q.value, q.unit);
  return out;
}

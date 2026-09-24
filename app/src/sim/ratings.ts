/**
 * Over-stress warnings for the running result (Sprint 5): the engine's datasheet check applied
 * to the current outcome, cached per outcome so re-renders do not repeat it. Presentation of a
 * documented limit, never physics: numbers shown elsewhere are the engine's, unchanged.
 */
import { createSnapshot, type ProjectDocument } from '@tbi-lab/domain';
import { ratingWarnings, type RatingWarning, type SolveSuccess } from '@tbi-lab/engine';

const cache = new WeakMap<SolveSuccess, RatingWarning[]>();

export function warningsFor(doc: ProjectDocument, outcome: SolveSuccess): RatingWarning[] {
  let w = cache.get(outcome);
  if (!w) {
    // Model parameters are structural (fixed while running), so the current document's
    // snapshot names the same models the outcome was solved with.
    w = ratingWarnings(createSnapshot(doc), outcome);
    cache.set(outcome, w);
  }
  return w;
}

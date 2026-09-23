import { checkCircuit, type CheckIssue, type ProjectDocument } from '@tbi-lab/domain';

/**
 * Circuit checks computed once per document version and shared by the canvas markers and the
 * inspector list. Documents are immutable (every edit produces a new object), so the object
 * itself is the cache key. Run/Stop never recomputes them (Sprint 4 perf finding).
 */
const cache = new WeakMap<ProjectDocument, CheckIssue[]>();

export function checksFor(doc: ProjectDocument): CheckIssue[] {
  let issues = cache.get(doc);
  if (!issues) {
    issues = checkCircuit(doc);
    cache.set(doc, issues);
  }
  return issues;
}

/**
 * TBI-019 G5: which project a learner's "Open this circuit" created for each guide, so the guide
 * can offer "Go back to my copy" instead of a second copy. IN MEMORY ONLY, by owner decision
 * D-1420-4: a module-level map that lives as long as the page. It is never written to
 * localStorage, sessionStorage or IndexedDB (no new stored data, no privacy-notice change).
 */
const copies = new Map<string, string>();

/** Remember that `projectId` is the learner's copy for guide `guideId` (replaces an older one). */
export function rememberGuideCopy(guideId: string, projectId: string): void {
  copies.set(guideId, projectId);
}

/**
 * The remembered copy for `guideId` if it still exists in `existingIds`; if the project is gone
 * the mapping is dropped and undefined is returned (the caller then creates a new copy).
 */
export function lookupGuideCopy(
  guideId: string,
  existingIds: Iterable<string>,
): string | undefined {
  const id = copies.get(guideId);
  if (id === undefined) return undefined;
  for (const e of existingIds) if (e === id) return id;
  copies.delete(guideId);
  return undefined;
}

export function forgetGuideCopy(guideId: string): void {
  copies.delete(guideId);
}

/** Test support: empty the registry. */
export function clearGuideCopies(): void {
  copies.clear();
}

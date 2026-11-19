// Pending skeleton for docs/a11y/keyboard-wiring-design.md section 2.1.
// `candidateTargets` (app/src/ui/wireKeyboard.ts) does not exist yet; these are todos, not passing claims.
import { describe, it } from 'vitest';

describe('candidateTargets (keyboard wiring, pure logic)', () => {
  it.todo('never includes the source pin');
  it.todo('excludes pins already joined to the source by a wire');
  it.todo('orders by canvas distance, ties by component id then terminal id');
  it.todo('is deterministic for the same document');
  it.todo('keeps risky targets (ground to supply) and attaches a hint instead of hiding them');
  it.todo('returns an empty list when the document has no other pins');
});

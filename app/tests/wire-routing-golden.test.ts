/**
 * Wire routing integrity (rt2): the canonical router reproduces, bit for bit, the routes that the
 * router of fae6a3c (before any rt2 change) produced for seeded random benches of 5 to 80
 * automatic wires (sparse, dense, with an ESP32 board), as opened and after one part is moved.
 * The guard for every performance change: determinism means the same document always gives the
 * same routes, so a faster router must give exactly the old ones.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { routeAutomatic } from '../src/ui/routing.js';
import { GOLDEN_CASES, caseKey, goldenDocs, routesHash } from './support/routingGolden.js';

const golden = JSON.parse(
  readFileSync(new URL('./fixtures/rt2-canonical-routes.json', import.meta.url), 'utf8'),
) as Record<string, { open: string; moved: string }>;

describe('canonical routes: golden (rt2)', () => {
  it('every golden bench routes exactly as fae6a3c did (opened and after a move)', () => {
    expect(Object.keys(golden).sort()).toEqual(GOLDEN_CASES.map(caseKey).sort());
    for (const c of GOLDEN_CASES) {
      const { open, moved } = goldenDocs(c, routeAutomatic);
      expect([routesHash(open), routesHash(moved)], caseKey(c)).toEqual([
        golden[caseKey(c)]!.open,
        golden[caseKey(c)]!.moved,
      ]);
    }
  });
});

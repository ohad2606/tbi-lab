/**
 * The s20r browser fixtures (app/e2e/fixtures/s20r/*.json), as produced by the support code: the
 * owner bench with the gate turned 180 degrees (it showed the arches over the gate before the fix),
 * and a crowded bench whose 3D bodies cannot be separated (the 3D view must name the wires it
 * cannot route safely). wire-routing-3d-owner.test.ts checks the committed files are exactly these.
 */
import { emptySelection, type ProjectDocument } from '@tbi-lab/domain';
import { moveRouted } from '../../src/ui/routing.js';
import { complexBench } from './complexBench.js';
import { ownerBench } from './ownerBench.js';
import { rng } from './routingBench.js';
import { normalize } from './wireScenario.js';

export function e2eFixtures(): Record<string, ProjectDocument> {
  const owner = ownerBench({ side: 'right', rotation: 180 }).doc;
  // The rt2 sweep recipe, seed 30 (wire-routing-3d-invariants.test.ts).
  const R = rng(30);
  const b = complexBench();
  let crowded = b.doc;
  for (const g of b.gates) {
    const d = { x: 20 * Math.round(R() * 16 - 8), y: 20 * Math.round(R() * 16 - 8) };
    const r = moveRouted(crowded, { ...emptySelection(), components: [g] }, d);
    if (r.ok) crowded = normalize(r.doc);
  }
  // Fixed timestamps (the benches are built with the system clock).
  const at = '2026-10-23T00:00:00.000Z';
  const fixed = (d: ProjectDocument, projectId: string, name: string): ProjectDocument => ({
    ...d,
    projectId,
    name,
    createdAt: at,
    revision: { ...d.revision, updatedAt: at },
  });
  return {
    'owner-rot180': fixed(owner, 'prj_s20rowner', 'Owner AND gate (rot 180)'),
    crowded: fixed(crowded, 'prj_s20rcrowded', 'Crowded gates'),
  };
}

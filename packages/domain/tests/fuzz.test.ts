/**
 * A4: after EVERY editing operation the document validates structurally. A seeded random
 * sequence of edits exercises combinations no hand-written case would think of.
 */
import { describe, expect, it } from 'vitest';
import {
  CATALOG_ORDER,
  CATALOG,
  addComponent,
  addWire,
  deleteSelection,
  emptySelection,
  moveSelection,
  rotateComponents,
  validateProject,
  wireRoute,
  type ProjectDocument,
  type WireTarget,
} from '../src/index.js';
import { newDoc } from './helpers.js';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomTarget(doc: ProjectDocument, r: () => number): WireTarget | undefined {
  const roll = r();
  if (roll < 0.2 && doc.layout.wires.length) {
    const w = doc.layout.wires[Math.floor(r() * doc.layout.wires.length)]!;
    const route = wireRoute(doc, w)!;
    const p = route[Math.floor(r() * route.length)]!;
    return { kind: 'wire', wire: w.id, at: p };
  }
  if (roll < 0.3 && doc.layout.junctions.length) {
    return {
      kind: 'junction',
      junction: doc.layout.junctions[Math.floor(r() * doc.layout.junctions.length)]!.id,
    };
  }
  if (!doc.components.length) return undefined;
  const c = doc.components[Math.floor(r() * doc.components.length)]!;
  const terms = CATALOG[c.type].terminals;
  return { kind: 'terminal', component: c.id, terminal: terms[Math.floor(r() * terms.length)]!.id };
}

describe('structural validity under random editing', () => {
  for (const seed of [1, 2, 3, 42, 2026]) {
    it(`seed ${seed}: 400 random operations, valid after each`, () => {
      const r = rng(seed);
      let doc = newDoc();
      let applied = 0;
      for (let step = 0; step < 400; step++) {
        const op = r();
        let result;
        if (op < 0.2) {
          const type = CATALOG_ORDER[Math.floor(r() * CATALOG_ORDER.length)]!;
          result = addComponent(doc, type, {
            x: Math.floor(r() * 800 - 400),
            y: Math.floor(r() * 600 - 300),
          });
        } else if (op < 0.6) {
          const a = randomTarget(doc, r);
          const b = randomTarget(doc, r);
          if (!a || !b) continue;
          const vertices =
            r() < 0.3 ? [{ x: Math.floor(r() * 400), y: Math.floor(r() * 400) }] : [];
          result = addWire(doc, a, b, vertices);
        } else if (op < 0.7 && doc.components.length) {
          const id = doc.components[Math.floor(r() * doc.components.length)]!.id;
          result = moveSelection(doc, { ...emptySelection(), components: [id] }, { x: 40, y: -20 });
        } else if (op < 0.8 && doc.components.length) {
          result = rotateComponents(doc, [
            doc.components[Math.floor(r() * doc.components.length)]!.id,
          ]);
        } else if (op < 0.9 && doc.layout.wires.length) {
          const w = doc.layout.wires[Math.floor(r() * doc.layout.wires.length)]!.id;
          result = deleteSelection(doc, { ...emptySelection(), wires: [w] });
        } else if (doc.components.length) {
          const id = doc.components[Math.floor(r() * doc.components.length)]!.id;
          result = deleteSelection(doc, { ...emptySelection(), components: [id] });
        } else continue;
        if (!result.ok) continue; // refusals (same endpoint, not on wire) are legitimate
        doc = result.doc;
        applied++;
        const issues = validateProject(doc);
        expect(issues, `step ${step}`).toEqual([]);
        // Every junction joins at least three wire ends.
        for (const j of doc.layout.junctions) {
          const ends = doc.layout.wires
            .flatMap((w) => [w.from, w.to])
            .filter((e) => e.kind === 'junction' && e.junction === j.id).length;
          expect(ends, `junction ${j.id} at step ${step}`).toBeGreaterThanOrEqual(3);
        }
        // Documents are plain JSON: the round trip is lossless.
        expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
      }
      expect(applied).toBeGreaterThan(200);
    });
  }
});

/**
 * Sprint 21 (s21r): a drawn route that reads as a connection it is not is REPORTED (domain
 * `routeConflictsReport`, Circuit view note `canvas.routeConflict`), never left unexplained:
 * through another terminal's keep-out, along a wire of another node, or meeting one with a T.
 * Wires of one node sharing a run (a trunk with branch dots) are not conflicts. The curated
 * examples and the owner benches have none.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { addComponent, addWire, routeConflictsReport, type ProjectDocument } from '@tbi-lab/domain';
import { componentBoxes, repairManual, routeAutomatic, routeConflicts } from '../src/ui/routing.js';
import { en } from '../src/i18n/messages.en.js';
import { he } from '../src/i18n/messages.he.js';
import { newDoc } from '../../packages/domain/tests/helpers.js';
import { ownerBench, ownerVariants } from './support/ownerBench.js';
import { OWNER_SHOT_FIXTURES } from './support/ownerShot.js';

const T = (component: string, terminal: string) => ({
  kind: 'terminal' as const,
  component,
  terminal,
});
const conflicts = (d: ProjectDocument) => routeConflictsReport(d, componentBoxes(d));

/** PSU1 and two resistors; R1.a on +, R2.a on -; manual wires laid as `paths` say. */
function bench(paths: { a: [number, number][]; b: [number, number][] }): ProjectDocument {
  let d = newDoc();
  for (const at of [
    { x: 200, y: -200 },
    { x: 200, y: 200 },
  ]) {
    const r = addComponent(d, 'component.resistor', at);
    if (!r.ok) throw new Error(r.error);
    d = r.doc;
  }
  const w1 = addWire(
    d,
    T('PSU1', 'positive'),
    T('R1', 'a'),
    paths.a.map(([x, y]) => ({ x, y })),
  );
  if (!w1.ok) throw new Error(w1.error);
  const w2 = addWire(
    w1.doc,
    T('PSU1', 'negative'),
    T('R2', 'a'),
    paths.b.map(([x, y]) => ({ x, y })),
  );
  if (!w2.ok) throw new Error(w2.error);
  return w2.doc;
}

describe('route conflicts are reported (s21r)', () => {
  it('a manual wire laid along a wire of another node is reported; laid apart it is not', () => {
    // + wire: right to x=60, up to R1's row. - wire: right, then ON the + wire's vertical run.
    const along = bench({
      a: [
        [60, -20],
        [60, -200],
      ],
      b: [
        [60, 20],
        [60, -100],
        [100, -100],
        [100, 200],
      ],
    });
    const r = conflicts(along);
    expect(r.limited).toBe(false);
    expect(r.wires.length).toBeGreaterThan(0);
    // The same circuit with the - wire on its own line.
    const apart = bench({
      a: [
        [60, -20],
        [60, -200],
      ],
      b: [
        [100, 20],
        [100, 200],
      ],
    });
    expect(conflicts(apart).wires).toEqual([]);
    // The app's cached view of it, and its note in both languages.
    expect(routeConflicts(along).wires).toEqual(r.wires);
    expect(en['canvas.routeConflict']).toMatch(/NOT connected/);
    expect(he['canvas.routeConflict']).toContain('{count}');
  });

  it('the curated examples, the owner benches and the owner-screenshot fixtures have none', () => {
    const dir = new URL('../src/examples/data/', import.meta.url);
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const d = routeAutomatic(repairManual(JSON.parse(readFileSync(new URL(f, dir), 'utf8'))));
      expect(conflicts(d), f).toEqual({ wires: [], limited: false });
    }
    for (const v of ownerVariants())
      expect(conflicts(ownerBench(v.options).doc).wires, v.name).toEqual([]);
    for (const [n, f] of Object.entries(OWNER_SHOT_FIXTURES))
      expect(conflicts(routeAutomatic(repairManual(f()))).wires, n).toEqual([]);
  });
});

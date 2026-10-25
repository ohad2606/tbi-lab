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
import { randomBench } from './support/routingBench.js';
import { largeBench } from './support/largeBench.js';

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
    expect(r.kinds.wire).toEqual(r.wires);
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
    for (const k of ['wire', 'pin', 'body', 'stacked', 'unchecked'] as const) {
      expect(en[`canvas.routeConflict.${k}`]).toContain('{ids}');
      expect(he[`canvas.routeConflict.${k}`]).toContain('{ids}');
    }
  });

  it('the curated examples, the owner benches and the owner-screenshot fixtures have none', () => {
    const dir = new URL('../src/examples/data/', import.meta.url);
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const d = routeAutomatic(repairManual(JSON.parse(readFileSync(new URL(f, dir), 'utf8'))));
      expect(conflicts(d), f).toEqual({
        wires: [],
        kinds: { wire: [], pin: [], body: [] },
        stacked: [],
        unchecked: [],
        limited: false,
      });
    }
    for (const v of ownerVariants())
      expect(conflicts(ownerBench(v.options).doc).wires, v.name).toEqual([]);
    for (const [n, f] of Object.entries(OWNER_SHOT_FIXTURES))
      expect(conflicts(routeAutomatic(repairManual(f()))).wires, n).toEqual([]);
  });

  // Review r5 (probe manual.ts): a manual wire laid THROUGH R1's body, along its lead axis
  // between its pins, reads as R1 in series: reported as `body`.
  it('a wire through the body of a part it is not wired to is reported (body)', () => {
    const d = bench({
      a: [],
      b: [
        [180, -200],
        [220, -200],
        [220, 300],
      ],
    });
    const r = conflicts(d);
    expect(r.kinds.body).toEqual(['W2']);
    expect(r.wires).toContain('W2');
  });

  // Review r5 (probe samenode.ts): passing over a pin of the wire's OWN node suggests nothing
  // false (they are connected): not reported; over a pin of another node it is (`pin`).
  it('over a pin of its own node is no conflict; over a pin of another node is', () => {
    let d = bench({ a: [], b: [] });
    const own = addWire(d, T('PSU1', 'positive'), T('R2', 'b'), [
      { x: -40, y: -20 },
      { x: -40, y: -260 },
      { x: 160, y: -260 },
      { x: 160, y: -100 },
      { x: 300, y: -100 },
      { x: 300, y: 200 },
    ]);
    if (!own.ok) throw new Error(own.error);
    d = own.doc;
    const w = d.layout.wires[d.layout.wires.length - 1]!.id;
    const r = conflicts(d);
    expect(r.kinds.pin).not.toContain(w); // over R1.a: its own node (PSU1 +)
    // The same wire on the - node (PSU1 - to R1.b) over R1.a, a pin of the + node.
    let e = bench({ a: [], b: [] });
    const other = addWire(e, T('PSU1', 'negative'), T('R1', 'b'), [
      { x: -40, y: 20 },
      { x: -40, y: -260 },
      { x: 160, y: -260 },
      { x: 160, y: -100 },
      { x: 300, y: -100 },
      { x: 300, y: -200 },
    ]);
    if (!other.ok) throw new Error(other.error);
    e = other.doc;
    expect(conflicts(e).kinds.pin).toContain(e.layout.wires[e.layout.wires.length - 1]!.id);
  });

  // Review r5 (finding 7): terminals of different parts drawn exactly on top of each other with
  // no connection (random bench: U7.y on U8.b) are reported, and so is the wire ending there.
  it('terminals of different nets on top of each other are reported (stacked)', () => {
    const d = routeAutomatic(randomBench(40, 1022, { dense: true }).doc);
    const r = conflicts(d);
    expect(r.stacked).toContainEqual({ x: 740, y: -80, terminals: ['U7.y', 'U8.b'] });
    expect(r.kinds.pin).toContain('W24');
  });

  // Review r5 (finding 4, probe big.ts: 2 x 10 000-vertex wires took 3.6-8.8 s): the check is
  // bounded per wire too; a wire past the cap is listed as unchecked, never silently dropped.
  it('the check is bounded; what it cannot reach is listed as unchecked', () => {
    for (const N of [2_000, 10_000]) {
      let d = bench({ a: [], b: [] });
      d = { ...d, layout: { ...d.layout, wires: [] } };
      const zz = (x0: number) =>
        Array.from({ length: N }, (_, i) => ({
          x: x0 + (i % 2) * 20,
          y: 1000 + Math.floor(i / 2) * 40,
        }));
      for (const [from, to, x0] of [
        [T('PSU1', 'positive'), T('R1', 'a'), 1000],
        [T('PSU1', 'negative'), T('R2', 'a'), 1010],
      ] as const) {
        const w = addWire(d, from, to, zz(x0));
        if (!w.ok) throw new Error(w.error);
        d = w.doc;
      }
      const t0 = performance.now();
      const r = conflicts(d);
      expect(performance.now() - t0, `${N}`).toBeLessThan(2_000);
      // Every wire is either checked (and the two interleaved wires conflict) or unchecked.
      for (const w of d.layout.wires)
        expect(r.wires.includes(w.id) || r.unchecked.includes(w.id), `${N} ${w.id}`).toBe(true);
      if (r.unchecked.length) expect(r.limited).toBe(true);
    }
    // A very large routed project: limited, and the rest listed.
    const big = routeAutomatic(largeBench(40, 15));
    const r = conflicts(big);
    expect(r.limited).toBe(true);
    expect(r.unchecked.length).toBeGreaterThan(0);
    const listed = new Set([...r.unchecked]);
    const checked = big.layout.wires.filter((w) => !listed.has(w.id));
    expect(checked.length).toBeGreaterThan(0);
  });
});

/**
 * Sprint 21 (s21r): the owner's screenshot case (support/ownerShot.ts: derived from the owner's
 * screenshots, not the serialized project).
 *  1. The fixture reproduces the 2D screenshot exactly, and every variant has the netlist written
 *     independently from the screenshot / the intent.
 *  2. No product path moves a wire END to another terminal (investigation of "the gate's GND wire
 *     ends on PSU1 +"): placement edits, segment drags, route automatically, undo/redo through
 *     the store, open-time repair and routing, export/import, a wire ended on a wire, a wire
 *     deleted next to a junction. Each keeps every wire's ends (or, for the two topology edits,
 *     gives exactly the netlist written for the edit).
 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import {
  addWire,
  deleteSelection,
  emptySelection,
  makeWiresAutomatic,
  moveWireSegment,
  wireRoute,
  type ProjectDocument,
  type WireEnd,
} from '@tbi-lab/domain';
import { ProjectStore } from '../src/persistence/store.js';
import { AppStore, type Preferences } from '../src/state/app.js';
import {
  componentBoxes,
  moveRouted,
  repairManual,
  rotateRouted,
  routeAutomatic,
} from '../src/ui/routing.js';
import { deriveScene } from '../src/views/scene3d/scene.js';
import { measure3d } from './support/wire3dMetrics.js';
import {
  OWNER_SHOT_FIXTURES,
  OWNER_SHOT_ROUTES,
  ownerShotExpectedNets,
} from './support/ownerShot.js';
import { T } from './support/ownerBench.js';
import { draw } from './support/wireScenario.js';

const key = (e: WireEnd) =>
  e.kind === 'terminal' ? `${e.component}:${e.terminal}` : `junction:${e.junction}`;

/** Independent netlist: union-find over the wires' end references (no geometry, no nets.ts). */
export function independentNets(d: ProjectDocument): string[][] {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    if (!parent.has(k)) parent.set(k, k);
    const p = parent.get(k)!;
    return p === k ? k : find(p);
  };
  for (const w of d.layout.wires) parent.set(find(key(w.from)), find(key(w.to)));
  const groups = new Map<string, string[]>();
  for (const k of parent.keys()) {
    if (k.startsWith('junction:')) continue;
    const r = find(k);
    groups.set(r, [...(groups.get(r) ?? []), k]);
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => g.sort())
    .sort((x, y) => (x[0]! < y[0]! ? -1 : 1));
}
/** The document's own netlist (`connections`), as the same kind of groups. */
const sorted = (g: string[][]) =>
  g.map((x) => [...x].sort()).sort((x, y) => (x[0]! < y[0]! ? -1 : 1));
const docNets = (d: ProjectDocument) => {
  const by = new Map<string, string[]>();
  for (const c of d.connections)
    by.set(c.net, [...(by.get(c.net) ?? []), `${c.component}:${c.terminal}`]);
  return [...by.values()]
    .filter((g) => g.length > 1)
    .map((g) => g.sort())
    .sort((x, y) => (x[0]! < y[0]! ? -1 : 1));
};
const ends = (d: ProjectDocument) =>
  JSON.stringify(d.layout.wires.map((w) => [w.id, key(w.from), key(w.to)]).sort());
const gateEnd = (d: ProjectDocument, t: string) =>
  d.layout.wires.find((w) => [w.from, w.to].some((e) => key(e) === `U1:${t}`))!;

describe('owner screenshot fixture (s21r)', () => {
  it('reproduces the 2D screenshot exactly; every variant has the independent netlist', () => {
    const exact = OWNER_SHOT_FIXTURES['shot-exact']!();
    for (const [t, want] of Object.entries(OWNER_SHOT_ROUTES)) {
      const w = gateEnd(exact, t);
      const r = wireRoute(exact, w)!;
      expect(key(w.from)).toBe(`U1:${t}`);
      expect(r).toEqual(want);
    }
    for (const [name, make] of Object.entries(OWNER_SHOT_FIXTURES)) {
      const d = make();
      const want = ownerShotExpectedNets(name);
      expect(independentNets(d), name).toEqual(want);
      expect(docNets(d), name).toEqual(want);
      // Open-time repair and routing change no end.
      const opened = routeAutomatic(repairManual(d));
      expect(ends(opened), name).toBe(ends(d));
      expect(docNets(opened), name).toEqual(want);
    }
  });

  it('no product path moves a wire end (store edits, undo/redo, open, import, wire-on-wire)', async () => {
    const prefs = (): Preferences => {
      const m: Record<string, string> = {};
      return { get: (k) => m[k] ?? null, set: (k, v) => void (m[k] = v) };
    };
    for (const [name, make] of Object.entries(OWNER_SHOT_FIXTURES)) {
      const storage = await ProjectStore.open(new IDBFactory());
      const app = new AppStore({
        storage,
        prefs: prefs(),
        languages: ['en'],
        newId: () => `id${Math.random().toString(36).slice(2, 8)}`,
        autosaveDebounceMs: 1,
        routeLayout: routeAutomatic,
        repairLayout: repairManual,
      });
      await app.init();
      await app.newProject('Owner');
      const doc = () => app.state.doc!;
      const start = make();
      app.apply({ ok: true, doc: { ...start, projectId: doc().projectId, name: doc().name } });
      const e0 = ends(doc());
      const base = app.state.history.undo;
      const n0 = ownerShotExpectedNets(name);
      const check = (what: string) => {
        expect(ends(doc()), `${name} ${what}`).toBe(e0);
        expect(docNets(doc()), `${name} ${what}`).toEqual(n0);
      };
      const sel = (ids: string[]) => ({ ...emptySelection(), components: ids });
      // Drag the gate away and back, the supply, rotate the gate four times.
      for (const [id, d] of [
        ['U1', { x: -200, y: 0 }],
        ['U1', { x: 200, y: 0 }],
        ['U1', { x: 0, y: 160 }],
        ['PSU1', { x: 160, y: 60 }],
        ['U1', { x: 0, y: -160 }],
        ['PSU1', { x: -160, y: -60 }],
      ] as const) {
        const m = moveRouted(doc(), sel([id]), d);
        expect(m.ok ? 'ok' : m.error, `${name} move ${id}`).toBe('ok');
        expect(app.apply(m)).toBe(true);
        check(`move ${id}`);
      }
      for (let i = 0; i < 4; i++) {
        expect(app.apply(rotateRouted(doc(), ['U1']))).toBe(true);
        check('rotate');
      }
      // Every segment of every wire dragged one step both ways, then made automatic again.
      for (const w of [...doc().layout.wires]) {
        const r = wireRoute(
          doc(),
          doc().layout.wires.find((x) => x.id === w.id)!,
        )!;
        for (let s = 0; s < r.length - 1; s++)
          for (const d of [
            { x: 20, y: 20 },
            { x: -20, y: -20 },
          ]) {
            const e = moveWireSegment(doc(), w.id, s, d);
            if (e.ok) app.apply(e);
            check('segment');
          }
      }
      app.apply(
        makeWiresAutomatic(
          doc(),
          doc().layout.wires.map((w) => w.id),
        ),
      );
      check('automatic');
      // Undo everything, redo everything.
      // Undo every edit made after the fixture, then redo them all.
      let undone = 0;
      while (app.state.history.undo > base && app.undo()) {
        undone++;
        check('undo');
      }
      while (app.redo()) check('redo');
      expect(undone).toBeGreaterThan(10);
      // Open (repair + canonical routing) and export -> import.
      await app.flush();
      const id = doc().projectId;
      await app.openProject(id);
      check('open');
      const file = (await app.exportProject(id))!;
      await app.deleteProject(id);
      expect(await app.importPackage(file.text)).toBe(true);
      check('import');
    }
  });

  it("a wire ended ON a wire joins THAT wire's node; deleting next to a junction keeps the rest", () => {
    // The corrected-intent bench: gate gnd on PSU1 -, the others on +.
    let d = OWNER_SHOT_FIXTURES['shot-intent']!();
    const gnd = gateEnd(d, 'gnd');
    const route = wireRoute(d, gnd)!;
    // A new wire from the output ended on the gnd wire's interior: a junction on the - node.
    const mid = { x: route[1]!.x, y: route[1]!.y };
    const r = addWire(d, T('U1', 'y'), { kind: 'wire', wire: gnd.id, at: mid });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    d = routeAutomatic(r.doc);
    expect(docNets(d)).toEqual(
      sorted([
        ['PSU1:positive', 'U1:a', 'U1:b', 'U1:vcc'],
        ['PSU1:negative', 'U1:gnd', 'U1:y'],
      ]),
    );
    // Ended on the gnd wire exactly at its END (PSU1 -): the wire takes that end, PSU1 -.
    const atEnd = addWire(d, T('U1', 'y'), {
      kind: 'wire',
      wire: d.layout.wires.find(
        (w) => key(w.to) === 'PSU1:negative' || key(w.from) === 'PSU1:negative',
      )!.id,
      at: { x: -80, y: 20 },
    });
    // (a parallel wire on the same node): it is attached to PSU1 - itself, no junction added.
    expect(atEnd.ok).toBe(true);
    if (atEnd.ok) {
      const w = atEnd.doc.layout.wires.find((x) => x.id === atEnd.id)!;
      expect(key(w.to)).toBe('PSU1:negative');
      expect(atEnd.doc.layout.junctions.length).toBe(d.layout.junctions.length);
    }
    // Deleting the junction's gate-side piece leaves the output wired to PSU1 - (joined wire).
    const j = d.layout.junctions[0]!;
    const piece = d.layout.wires.find((w) => key(w.from) === 'U1:gnd' || key(w.to) === 'U1:gnd')!;
    expect([piece.from, piece.to].some((e) => e.kind === 'junction' && e.junction === j.id)).toBe(
      true,
    );
    const del = deleteSelection(d, { ...emptySelection(), wires: [piece.id] });
    expect(del.ok).toBe(true);
    if (!del.ok) return;
    expect(docNets(del.doc)).toEqual(
      sorted([
        ['PSU1:negative', 'U1:y'],
        ['PSU1:positive', 'U1:a', 'U1:b', 'U1:vcc'],
      ]),
    );
    expect(independentNets(del.doc)).toEqual(docNets(del.doc));
    // And a plain draw to PSU1 - stays on PSU1 - after every routing pass.
    const again = draw(OWNER_SHOT_FIXTURES['shot-intent']!(), T('U1', 'y'), T('PSU1', 'negative'));
    expect(key(gateEnd(again, 'y').to)).toBe('PSU1:negative');
  });

  it('2D: no automatic wire runs along a part outline (beyond its first step); 3D: no arch, loop or collision', () => {
    // Known 3D remainder, pinned: the gate's V_CC lane ends right under the b / a wire's run one
    // grid step outside the gate (the 3D board is larger than its symbol): the two touch where
    // V_CC rises from its pin. Same node; no other contact.
    const KNOWN_OWN: Record<string, string[]> = {
      'shot-exact': ['W1-W4'],
      'shot-drawn': ['W1-W4'],
      'shot-intent': ['W2-W4'],
    };
    for (const [name, make] of Object.entries(OWNER_SHOT_FIXTURES)) {
      const d = routeAutomatic(repairManual(make()));
      const boxes = componentBoxes(d).filter((b) => !b.display);
      for (const w of d.layout.wires) {
        if (!w.auto || w.auto.waypoints.length) continue; // the user's own geometry or clicks
        const r = wireRoute(d, w)!;
        let along = 0;
        for (let i = 1; i < r.length; i++) {
          const [a, b] = [r[i - 1]!, r[i]!];
          for (const q of boxes) {
            const h = a.y === b.y;
            const on = h ? a.y === q.minY || a.y === q.maxY : a.x === q.minX || a.x === q.maxX;
            if (!on) continue;
            const [lo, hi] = h ? [q.minX, q.maxX] : [q.minY, q.maxY];
            const [p0, p1] = h ? [a.x, b.x] : [a.y, b.y];
            let n = Math.max(0, Math.min(Math.max(p0, p1), hi) - Math.max(Math.min(p0, p1), lo));
            // The first grid step out of its own terminal on that part is its lead.
            const end = [r[0]!, r[r.length - 1]!].some((e) =>
              (e.x === a.x && e.y === a.y) || (e.x === b.x && e.y === b.y)
                ? e.x >= q.minX && e.x <= q.maxX && e.y >= q.minY && e.y <= q.maxY
                : false,
            );
            if (end) n = Math.max(0, n - 20);
            along += n;
          }
        }
        expect(along, `${name} ${w.id} along an outline`).toBe(0);
      }
      const s = deriveScene(d);
      const m = measure3d(d, s);
      expect(m.foreignPenetrations, name).toEqual([]);
      expect(m.bodyHits, name).toEqual([]);
      expect(m.loops, name).toEqual([]);
      expect(m.hairpins, name).toEqual([]);
      expect(m.overOwnBody, name).toEqual([]);
      expect(m.badEnds, name).toEqual([]);
      expect(
        m.ownPenetrations.map((p) => `${p.a}-${p.b}`),
        name,
      ).toEqual(KNOWN_OWN[name] ?? []);
      // No wire climbs over the supply's case (11 mm) or the gate's board (it was 12.2 mm).
      for (const w of s.wires)
        expect(Math.max(...w.points.map((p) => p.y)), `${name} ${w.id}`).toBeLessThan(8);
      expect(s.routeLimits, name).toEqual([]);
    }
  });
});

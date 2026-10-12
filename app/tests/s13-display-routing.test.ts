/**
 * Sprint 13 OS-05 (Owner Smoke): wires must not cover a part's display (an LCD's text, a matrix's
 * dots) where another route exists. A display face is a protected routing region (domain route.ts
 * criterion 2, ahead of everything but terminal keep-out), as large as the face in the Circuit
 * view AND as the 3D view shows it (the LCD module is about twice its symbol's width), so a route
 * clear of it in 2D is clear of it in 3D.
 */
import { describe, expect, it } from 'vitest';
import {
  addComponent,
  addWire,
  autoRoute,
  createProject,
  repairWireRoutes,
  routeObstacles,
  wireRoute,
  type Point,
  type ProjectDocument,
  type RouteBox,
} from '@tbi-lab/domain';
import { DISPLAY_FACES, componentBoxes, displayBoxes } from '../src/ui/routing.js';
import { LCD_WINDOW } from '../src/ui/symbols.js';
import { LCD1602_MODULE as L, MM_PER_LAYOUT_UNIT as U } from '../src/views/scene3d/physical.js';
import { deriveScene } from '../src/views/scene3d/scene.js';

/** Length of an orthogonal path inside a box's interior. */
function lengthIn(path: readonly Point[], q: RouteBox): number {
  let n = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const [a, b] = [path[i]!, path[i + 1]!];
    if (a.y === b.y && a.y > q.minY && a.y < q.maxY)
      n += Math.max(0, Math.min(Math.max(a.x, b.x), q.maxX) - Math.max(Math.min(a.x, b.x), q.minX));
    if (a.x === b.x && a.x > q.minX && a.x < q.maxX)
      n += Math.max(0, Math.min(Math.max(a.y, b.y), q.maxY) - Math.max(Math.min(a.y, b.y), q.minY));
  }
  return n;
}

function lcdDoc(): { doc: ProjectDocument; lcd: string; r1: string; r2: string } {
  let doc = createProject({ projectId: 'prj_os05', deviceId: 'd', name: 'OS-05', appVersion: '0' });
  const add = (type: Parameters<typeof addComponent>[1], x: number, y: number) => {
    const r = addComponent(doc, type, { x, y });
    if (!r.ok) throw new Error(r.error);
    doc = r.doc;
    return r.id;
  };
  const lcd = add('display.lcd1602_i2c', 600, 600);
  // Two resistors left and right of the display, on the row of its text.
  const r1 = add('component.resistor', 200, 600);
  const r2 = add('component.resistor', 1200, 600);
  return { doc, lcd, r1, r2 };
}

describe('OS-05: display faces are protected routing regions', () => {
  it('the LCD face covers its drawn text window and its real (3D) bezel', () => {
    const f = DISPLAY_FACES['display.lcd1602_i2c']!;
    expect(f[0]).toBeLessThanOrEqual(LCD_WINDOW.x);
    expect(f[2]).toBeGreaterThanOrEqual(LCD_WINDOW.x + LCD_WINDOW.w);
    // 70.7 mm bezel = 445 layout units: far wider than the 172-unit drawn window.
    expect(f[2] - f[0]).toBeGreaterThan(440);
  });

  it('a new wire whose shortest shape runs across the display goes around it', () => {
    const { doc } = lcdDoc();
    const face = displayBoxes(doc)[0]!;
    const a = { x: 240, y: 600 }; // R1.b
    const b = { x: 1160, y: 600 }; // R2.a
    expect(lengthIn([a, b], face)).toBeGreaterThan(0); // the straight route would cover it
    const path = autoRoute([a, b], routeObstacles(doc, componentBoxes(doc)));
    expect(path[0]).toEqual(a);
    expect(path.at(-1)).toEqual(b);
    expect(lengthIn(path, face)).toBe(0);
  });

  it('a stored wire across the display is re-routed around it when the project opens', () => {
    const { doc: d0, r1, r2 } = lcdDoc();
    const w = addWire(
      d0,
      { kind: 'terminal', component: r1, terminal: 'b' },
      { kind: 'terminal', component: r2, terminal: 'a' },
    );
    if (!w.ok) throw new Error(w.error);
    const face = displayBoxes(w.doc)[0]!;
    const before = wireRoute(w.doc, w.doc.layout.wires[0]!)!;
    expect(lengthIn(before, face)).toBeGreaterThan(0);
    const repaired = repairWireRoutes(w.doc, componentBoxes(w.doc));
    const after = wireRoute(repaired, repaired.layout.wires[0]!)!;
    expect(lengthIn(after, face)).toBe(0);
    // The 3D view's wire follows it: before, it ran over the LCD's real screen; after, it does
    // not (plan samples along every 3D segment against the physical bezel).
    const over = (d: ProjectDocument) => {
      const cx = 600 * U + L.pcbLeftXMm + L.pcbXMm / 2;
      const cz = 600 * U + L.pcbCentreZMm;
      let n = 0;
      for (const wire of deriveScene(d).wires) {
        const P = wire.points;
        for (let i = 0; i < P.length - 1; i++)
          for (let t = 0; t <= 50; t++) {
            const x = P[i]!.x + ((P[i + 1]!.x - P[i]!.x) * t) / 50;
            const z = P[i]!.z + ((P[i + 1]!.z - P[i]!.z) * t) / 50;
            if (Math.abs(x - cx) < L.bezelXMm / 2 && Math.abs(z - cz) < L.bezelZMm / 2) n++;
          }
      }
      return n;
    };
    expect(over(w.doc)).toBeGreaterThan(0);
    expect(over(repaired)).toBe(0);
    // Endpoints, and so connectivity, are untouched.
    expect(repaired.layout.wires[0]!.from).toEqual(w.doc.layout.wires[0]!.from);
    expect(repaired.layout.wires[0]!.to).toEqual(w.doc.layout.wires[0]!.to);
  });

  it("a wire to the display's own pins still routes (the header is outside the face)", () => {
    const { doc, lcd, r1 } = lcdDoc();
    const w = addWire(
      doc,
      { kind: 'terminal', component: r1, terminal: 'b' },
      { kind: 'terminal', component: lcd, terminal: 'sda' },
    );
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    const route = wireRoute(w.doc, w.doc.layout.wires[0]!)!;
    expect(lengthIn(route, displayBoxes(w.doc)[0]!)).toBe(0);
  });
});

/**
 * Wire auto-routing, in Chromium (Product Alpha maintenance). The reproduced circuit:
 * PSU+ -> LED -> resistor on one row, then a return wire from the resistor to PSU-. The return
 * must get its own route below the circuit, both while it is being drawn (preview) and once
 * committed, so the drawing reads as a closed loop of two distinct conductors.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  createProject,
  place,
  storedProject,
  terminal,
  toScreen,
  waitSaved,
  wire,
} from './helpers.js';

type P = { x: number; y: number };
const parsePoints = (s: string): P[] =>
  s
    .trim()
    .split(/\s+/)
    .map((xy) => {
      const [x, y] = xy.split(',').map(Number);
      return { x: x!, y: y! };
    });

/** Length of coincident horizontal/vertical runs between two polylines. */
function overlap(a: P[], b: P[]): number {
  let n = 0;
  for (let i = 0; i < a.length - 1; i++)
    for (let j = 0; j < b.length - 1; j++) {
      const [p, q, r, s] = [a[i]!, a[i + 1]!, b[j]!, b[j + 1]!];
      if (p.y === q.y && r.y === s.y && p.y === r.y)
        n += Math.max(
          0,
          Math.min(Math.max(p.x, q.x), Math.max(r.x, s.x)) -
            Math.max(Math.min(p.x, q.x), Math.min(r.x, s.x)),
        );
      if (p.x === q.x && r.x === s.x && p.x === r.x)
        n += Math.max(
          0,
          Math.min(Math.max(p.y, q.y), Math.max(r.y, s.y)) -
            Math.max(Math.min(p.y, q.y), Math.min(r.y, s.y)),
        );
    }
  return n;
}

async function drawnRoutes(page: Page): Promise<Record<string, P[]>> {
  const out: Record<string, P[]> = {};
  for (const g of await page.locator('g.wire-group').all()) {
    const id = (await g.getAttribute('data-id'))!;
    out[id] = parsePoints((await g.locator('polyline.wire-hit').getAttribute('points'))!);
  }
  return out;
}

test('the reproduced return wire gets its own route below the circuit (preview and committed)', async ({
  page,
}, info) => {
  await createProject(page, 'Loop');
  await place(page, 'component.led', { x: 0, y: -20 });
  await place(page, 'component.resistor', { x: 120, y: -20 });
  await wire(page, ['PSU1', 'positive'], ['D1', 'anode']);
  await wire(page, ['D1', 'cathode'], ['R1', 'a']);
  await waitSaved(page);
  const upper = Object.values(await drawnRoutes(page));
  expect(upper).toHaveLength(2);

  // Start the return at R1.b and hover PSU-: the live preview already takes its own channel.
  await terminal(page, 'R1', 'b').locator('.terminal-hit').click();
  const target = await toScreen(page, { x: -80, y: 20 });
  await page.mouse.move(target.x, target.y, { steps: 8 });
  const preview = parsePoints(
    (await page.locator('polyline.wire-preview').getAttribute('points'))!,
  );
  for (const u of upper) expect(overlap(preview, u)).toBe(0);
  expect(preview[1]).toEqual({ x: 160, y: 20 });
  await page.getByTestId('canvas').screenshot({ path: info.outputPath('wire-return-preview.png') });

  await terminal(page, 'PSU1', 'negative').locator('.terminal-hit').click();
  await waitSaved(page);
  const doc = await storedProject(page);
  const ret = doc.layout.wires.find(
    (w) => w.from.kind === 'terminal' && w.from.component === 'R1' && w.from.terminal === 'b',
  )!;
  expect(ret.vertices).toEqual([{ x: 160, y: 20 }]);
  const routes = await drawnRoutes(page);
  const drawn = routes[ret.id]!;
  expect(drawn).toEqual([
    { x: 160, y: -20 },
    { x: 160, y: 20 },
    { x: -80, y: 20 },
  ]);
  for (const u of upper) expect(overlap(drawn, u)).toBe(0);
  // A closed loop of distinct conductors: no junction was created, the return has its own row.
  expect(doc.layout.junctions).toHaveLength(0);
  await page
    .getByTestId('canvas')
    .screenshot({ path: info.outputPath('wire-return-committed.png') });
});

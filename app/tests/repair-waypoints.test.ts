/**
 * Sprint 20 (s20r round 3): the open-time repair of a MANUAL wire keeps the user's bends wherever
 * the rules allow. The GPIO19 read-back wire of `esp32-logic-override` was stored with bends one
 * grid step beside the ESP32 header (inside the header row's exclusion band: any route through
 * them runs along the header); the repair used to drop every bend and run the wire straight at the
 * gate. It now keeps the bend that is legal, (500,-120), and reaches it clear of the header.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { repairWireRoutes, wireRoute, type ProjectDocument } from '@tbi-lab/domain';
import { componentBoxes } from '../src/ui/routing.js';

const example = (id: string) =>
  JSON.parse(
    readFileSync(new URL(`../src/examples/data/${id}.json`, import.meta.url), 'utf8'),
  ) as ProjectDocument;

describe('open-time repair keeps the legal bends of a manual wire (s20r round 3)', () => {
  it('esp32-logic-override GPIO19: the read-back keeps its run over the top', () => {
    const doc = example('esp32-logic-override');
    const before = doc.layout.wires.find((w) => w.id === 'W18')!;
    expect(before.vertices).toContainEqual({ x: 500, y: -120 });
    const repaired = repairWireRoutes(doc, componentBoxes(doc));
    const after = wireRoute(
      repaired,
      repaired.layout.wires.find((w) => w.id === 'W18')!,
    )!;
    expect(after).toContainEqual({ x: 500, y: -120 });
    expect(repaired.connections).toEqual(doc.connections);
  });
});

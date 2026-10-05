/**
 * Sprint 9: a direct terminal-to-terminal contact (a zero-length wire, domain contacts.ts) is a
 * real connection for the simulation: R1 touching D1 solves exactly like R1 wired to D1.
 */
import { describe, expect, it } from 'vitest';
import {
  addComponent,
  addWire,
  contacts,
  createProject,
  createSnapshot,
  moveSelection,
  setParam,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { EngineSession, type SolveOutcome, type SolveSuccess } from '../src/index.js';

const ok = (o: SolveOutcome): SolveSuccess => {
  if (!o.ok) throw new Error(JSON.stringify(o));
  return o;
};
function must(r: { ok: true; doc: ProjectDocument } | { ok: false; error: string }) {
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}
const t = (component: string, terminal: string) => ({
  kind: 'terminal' as const,
  component,
  terminal,
});

/** PSU1 (5 V) → R1 (220 Ω) → D1 (LED) → GND1; D1's anode `gap` units right of R1.b. */
function bench(gap: number, wired: boolean): ProjectDocument {
  let doc = createProject({ projectId: 'prj_contact', deviceId: 'd', name: 'C', appVersion: '0' });
  const add = (type: 'component.resistor' | 'component.led', x: number) => {
    const r = addComponent(doc, type, { x, y: 300 });
    if (!r.ok) throw new Error(r.error);
    doc = r.doc;
  };
  add('component.resistor', 0);
  add('component.led', 80 + gap);
  doc = must(setParam(doc, 'R1', 'resistance', { value: 220, unit: 'ohm' }));
  doc = must(setParam(doc, 'PSU1', 'setpointVoltage', { value: 5, unit: 'volt' }));
  doc = must(setParam(doc, 'PSU1', 'outputEnabled', true));
  doc = must(addWire(doc, t('PSU1', 'positive'), t('R1', 'a')));
  doc = must(addWire(doc, t('D1', 'cathode'), t('GND1', 'ref')));
  doc = must(addWire(doc, t('PSU1', 'negative'), t('GND1', 'ref')));
  if (wired) doc = must(addWire(doc, t('R1', 'b'), t('D1', 'anode')));
  return doc;
}

describe('direct contact in the simulation', () => {
  it('touching leads conduct exactly like a wire; separated, no current flows', () => {
    const touching = bench(0, false);
    expect(contacts(touching)).toHaveLength(1);
    const viaContact = ok(new EngineSession(createSnapshot(touching)).solve());
    const viaWire = ok(new EngineSession(createSnapshot(bench(60, true))).solve());
    const i = viaContact.components.D1!.current!;
    expect(i).toBeGreaterThan(0.01);
    expect(i).toBeCloseTo(viaWire.components.D1!.current!, 12);
    // Pull D1 away: the contact is gone and the LED is out of the circuit.
    const apart = must(
      moveSelection(touching, { components: ['D1'], wires: [], junctions: [] }, { x: 0, y: 60 }),
    );
    expect(contacts(apart)).toEqual([]);
    const off = new EngineSession(createSnapshot(apart)).solve();
    const current = off.ok ? (off.components.D1?.current ?? 0) : 0;
    expect(current).toBe(0);
  });
});

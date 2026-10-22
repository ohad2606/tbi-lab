import { it } from 'vitest';
import { routeAutomatic } from '../src/ui/routing.js';
import { draw, ownerCircuit, normalize } from './support/wireScenario.js';
import { addComponent } from '@tbi-lab/domain';
it('prof', () => {
  let { doc, gate } = ownerCircuit();
  const T = (c: string, t: string) => ({ kind: 'terminal' as const, component: c, terminal: t });
  const add = (type: any, at: any) => {
    const r = addComponent(doc, type, at);
    if (!r.ok) throw 0;
    doc = normalize(r.doc);
    return r.id;
  };
  const g2 = add('logic.gate_nand', { x: 240, y: 0 });
  const g3 = add('logic.gate_or', { x: 240, y: 240 });
  const r = add('component.resistor', { x: 480, y: 0 });
  const d = add('component.led', { x: 480, y: 240 });
  for (const [a, b] of [
    [T('PSU1', 'positive'), T(g2, 'vcc')],
    [T(g2, 'gnd'), T('GND1', 'ref')],
    [T('PSU1', 'positive'), T(g3, 'vcc')],
    [T(g3, 'gnd'), T('GND1', 'ref')],
    [T(gate, 'y'), T(g2, 'a')],
    [T(g2, 'y'), T(r, 'a')],
    [T(r, 'b'), T(d, 'anode')],
    [T(d, 'cathode'), T('GND1', 'ref')],
  ] as const)
    doc = draw(doc, a as any, b as any);
  const t0 = performance.now();
  for (let i = 0; i < 5; i++) routeAutomatic(doc);
  console.log('routeAutomatic avg ms', ((performance.now() - t0) / 5).toFixed(1));
});

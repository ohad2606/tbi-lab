/** Sprint 10 circuit fixtures (shared by the semantics, parts and example tests). */
import { newDoc } from '../../packages/domain/tests/helpers.js';
import { place, wire } from '../../packages/domain/tests/circuits.js';

/**
 * Sprint 10 parts in one circuit: a toggle drives a relay coil; its contacts route the supply to an
 * RGB LED channel (NO) or a buzzer (NC); a photoresistor feeds the green channel.
 */
export function sprint10Circuit() {
  let doc = newDoc();
  const ids: Record<string, string> = { psu: 'PSU1', g1: 'GND1' };
  for (const [k, type, x, y] of [
    ['sw', 'component.toggle_switch', -260, 200],
    ['k', 'component.relay', 0, 200],
    ['g2', 'component.ground', -60, 360],
    ['r1', 'component.resistor', 220, 120],
    ['rgb', 'component.rgb_led', 420, 200],
    ['g3', 'component.ground', 540, 300],
    ['bz', 'component.buzzer', 220, 360],
    ['g4', 'component.ground', 340, 460],
    ['ldr', 'component.photoresistor', 100, 540],
    ['r2', 'component.resistor', 280, 600],
  ] as const) {
    const r = place(doc, type, x, y);
    doc = r.doc;
    ids[k] = r.id;
  }
  const w = (a: [string, string], b: [string, string]) => (doc = wire(doc, a, b));
  w([ids.psu!, 'negative'], [ids.g1!, 'ref']);
  w([ids.psu!, 'positive'], [ids.sw!, 'a']);
  w([ids.sw!, 'b'], [ids.k!, 'coil1']);
  w([ids.k!, 'coil2'], [ids.g2!, 'ref']);
  w([ids.psu!, 'positive'], [ids.k!, 'com']);
  w([ids.k!, 'no'], [ids.r1!, 'a']);
  w([ids.r1!, 'b'], [ids.rgb!, 'red']);
  w([ids.rgb!, 'cathode'], [ids.g3!, 'ref']);
  w([ids.k!, 'nc'], [ids.bz!, 'positive']);
  w([ids.bz!, 'negative'], [ids.g4!, 'ref']);
  w([ids.psu!, 'positive'], [ids.ldr!, 'a']);
  w([ids.ldr!, 'b'], [ids.r2!, 'a']);
  w([ids.r2!, 'b'], [ids.rgb!, 'green']);
  return { doc, ids };
}

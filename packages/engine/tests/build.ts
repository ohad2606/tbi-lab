/** Build real project documents through the domain editing operations, then snapshot them. */
import {
  addComponent,
  addWire,
  createProject,
  createSnapshot,
  setParam,
  type ComponentTypeId,
  type ParamValue,
  type ProjectDocument,
} from '@tbi-lab/domain';

export class Bench {
  doc: ProjectDocument;
  private x = 0;
  constructor() {
    // createProject places PSU1 and GND1.
    this.doc = createProject({
      projectId: 'prj_engine',
      deviceId: 'd',
      name: 'Engine',
      appVersion: '0',
    });
  }
  add(type: ComponentTypeId): string {
    this.x += 200;
    const r = addComponent(this.doc, type, { x: this.x, y: 400 });
    if (!r.ok) throw new Error(r.error);
    this.doc = r.doc;
    return r.id;
  }
  wire(a: string, b: string): this {
    const [ac, at] = a.split('.') as [string, string];
    const [bc, bt] = b.split('.') as [string, string];
    const r = addWire(
      this.doc,
      { kind: 'terminal', component: ac, terminal: at },
      { kind: 'terminal', component: bc, terminal: bt },
    );
    if (!r.ok) throw new Error(`${a}->${b}: ${r.error}`);
    this.doc = r.doc;
    return this;
  }
  set(id: string, key: string, value: ParamValue): this {
    const r = setParam(this.doc, id, key, value);
    if (!r.ok) throw new Error(`${id}.${key}: ${r.error}`);
    this.doc = r.doc;
    return this;
  }
  psu(volts: number, amps: number, enabled = true): this {
    return this.set('PSU1', 'setpointVoltage', { value: volts, unit: 'volt' })
      .set('PSU1', 'currentLimit', { value: amps, unit: 'ampere' })
      .set('PSU1', 'outputEnabled', enabled);
  }
  ohms(id: string, value: number): this {
    return this.set(id, 'resistance', { value, unit: 'ohm' });
  }
  snapshot() {
    return createSnapshot(this.doc);
  }
}

/** PSU1 -> R1 -> GND, PSU1- -> GND. */
export function resistorLoop(volts: number, amps: number, ohms: number, enabled = true): Bench {
  const b = new Bench();
  const r = b.add('component.resistor');
  return b
    .wire('PSU1.positive', `${r}.a`)
    .wire(`${r}.b`, 'GND1.ref')
    .wire('PSU1.negative', 'GND1.ref')
    .psu(volts, amps, enabled)
    .ohms(r, ohms);
}

/** PSU1 -> R1 -> D1 (LED) -> GND. */
export function ledLoop(volts: number, amps: number, ohms: number, enabled = true): Bench {
  const b = new Bench();
  const r = b.add('component.resistor');
  const d = b.add('component.led');
  return b
    .wire('PSU1.positive', `${r}.a`)
    .wire(`${r}.b`, `${d}.anode`)
    .wire(`${d}.cathode`, 'GND1.ref')
    .wire('PSU1.negative', 'GND1.ref')
    .psu(volts, amps, enabled)
    .ohms(r, ohms);
}

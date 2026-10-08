/**
 * Sprint 10 parts (PM-6 revision), the vertical stack below the browser: serialization round
 * trip, schematic mapping (symbols, pins, part numbers), 3D models and terminal agreement, and the
 * engine solving the combined circuit in both switch positions. Cross-view agreement of the same
 * circuit is in semantics.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  CATALOG,
  defaultParams,
  createPackage,
  createSnapshot,
  parsePackage,
  serializePackage,
  setParam,
  validateProject,
  type ComponentTypeId,
} from '@tbi-lab/domain';
import { EngineSession, partNumber, type SolveSuccess } from '@tbi-lab/engine';
import { must } from '../../packages/domain/tests/helpers.js';
import { sprint10Circuit } from './circuits10.js';
import { schematicLayout } from '../src/views/schematic/layout.js';
import { SCHEMATIC_SYMBOLS } from '../src/views/schematic/symbols.js';
import { MODEL_FOR, SCALE, deriveScene } from '../src/views/scene3d/scene.js';
import { RELAY_SRD } from '../src/views/scene3d/physical.js';
import { SYMBOLS } from '../src/ui/symbols.js';
import { buildSessionRequest } from '../src/runtime/snapshot.js';

const NEW_TYPES: ComponentTypeId[] = [
  'component.rgb_led',
  'component.photoresistor',
  'component.buzzer',
  'component.relay',
  'component.bjt_npn',
  'sensor.pir_hc_sr501',
  'display.led_matrix_8x8',
  'component.capacitor',
];

/** Sprint 11 (R1): Sprint 10 parts enabled for ESP32 projects so far. */
const R1_ESP32: ComponentTypeId[] = [
  'component.rgb_led',
  'component.buzzer',
  'sensor.pir_hc_sr501',
  'component.bjt_npn',
  'component.relay',
  'component.photoresistor',
];

describe('Sprint 10 parts: catalog and serialization', () => {
  it('every new type has terminals on the grid inside its 2D symbol, a 3D model and a schematic symbol', () => {
    for (const type of NEW_TYPES) {
      const def = CATALOG[type];
      const [x0, y0, x1, y1] = SYMBOLS[type].bbox;
      for (const t of def.terminals) {
        expect(Math.abs(t.offset.x % 20), `${type}.${t.id}`).toBe(0);
        expect(Math.abs(t.offset.y % 20), `${type}.${t.id}`).toBe(0);
        expect(t.offset.x >= x0 && t.offset.x <= x1 && t.offset.y >= y0 && t.offset.y <= y1).toBe(
          true,
        );
      }
      expect(MODEL_FOR[type]).toBeDefined();
      expect(SCHEMATIC_SYMBOLS[type]).toBeDefined();
      // Sprint 11 (R1): enabled for ESP32 projects slice by slice; the capacitor stays refused
      // (time-dependent). R1_ESP32 lists the parts enabled so far.
      expect(def.mcuRuntime, type).toBe(R1_ESP32.includes(type) ? undefined : false);
    }
  });

  it('a project with every new part validates and survives export/import unchanged', () => {
    let { doc } = sprint10Circuit();
    doc = must(setParam(doc, 'LDR1', 'illuminance', { value: 35, unit: 'lux' })).doc;
    expect(validateProject(doc)).toEqual([]);
    const text = serializePackage(
      createPackage(doc, { appVersion: 't', exportedAt: '2026-10-06T00:00:00.000Z' }),
    );
    const back = parsePackage(text);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.doc).toEqual(doc);
    // Language-neutral tokens only: no display text in the stored parts.
    const stored = doc.components.filter((c) => NEW_TYPES.includes(c.type));
    expect(stored.map((c) => c.params)).toEqual([
      { model: 'model.relay.songle_srd_05vdc_sl_c' },
      { model: 'model.rgb_led.kingbright_wp154a4sureqbfzgc' },
      { model: 'model.buzzer.cui_cem_1205_ic' },
      { model: 'model.ldr.senba_gl5528', illuminance: { value: 35, unit: 'lux' } },
    ]);
  });

  it('Sprint 11: an ESP32 project holding the enabled parts passes the parts rule (next: the circuit checks)', () => {
    const { doc } = sprint10Circuit();
    const r = buildSessionRequest(
      {
        ...doc,
        components: [
          ...doc.components,
          {
            id: 'U1',
            type: 'board.esp32_devkitc_wroom32',
            typeVersion: 1,
            params: { firmware: 'program' },
          },
        ],
        layout: {
          ...doc.layout,
          components: { ...doc.layout.components, U1: { x: 0, y: -600, rotation: 0 } },
        },
      },
      () => ({ code: 'mcu_no_program', components: ['U1'] }),
    );
    expect(r.ok).toBe(false);
    // Relay, RGB LED, buzzer and photoresistor are all enabled for the ESP32 in R1: the request is
    // not refused for them; it stops at the next check (this test board's GND is not wired).
    expect(doc.components.every((c) => CATALOG[c.type].mcuRuntime !== false)).toBe(true);
    if (!r.ok) expect(r.error.code).toBe('mcu_ground_unconnected');
  });

  it('Sprint 11: a capacitor in an ESP32 project is refused as time-dependent, by name', () => {
    let doc = sprint10Circuit().doc;
    doc = { ...doc, components: doc.components.filter((c) => c.type === 'component.resistor') };
    const withBoard = (d: typeof doc, extra: typeof doc.components) => ({
      ...d,
      components: [
        ...d.components,
        ...extra,
        {
          id: 'U1',
          type: 'board.esp32_devkitc_wroom32' as const,
          typeVersion: 1,
          params: { firmware: 'program' },
        },
      ],
      layout: {
        ...d.layout,
        components: {
          ...d.layout.components,
          U1: { x: 0, y: -600, rotation: 0 as const },
          C1: { x: 400, y: -600, rotation: 0 as const },
        },
      },
    });
    const r = buildSessionRequest(
      withBoard(doc, [
        {
          id: 'C1',
          type: 'component.capacitor',
          typeVersion: 1,
          params: defaultParams(CATALOG['component.capacitor']),
        },
      ]),
      () => ({ code: 'mcu_no_program', components: ['U1'] }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.error).toEqual({ code: 'mcu_component_time_dependent', components: ['C1'] });
  });
});

describe('Sprint 10 parts: schematic', () => {
  it('multi-pin parts are labelled blocks with their conventional glyph; two-pin parts carry part numbers', () => {
    const { doc } = sprint10Circuit();
    const l = schematicLayout(doc);
    const rgb = l.modules.find((m) => m.component === 'D1')!;
    const relay = l.modules.find((m) => m.component === 'K1')!;
    expect(rgb.glyph).toBe('rgb_led.cc');
    expect(relay.glyph).toBe('relay.spdt');
    // Every wired pin is shown by its technical name.
    expect(relay.pins.map((p) => p.name).sort()).toEqual(['A1', 'A2', 'COM', 'NC', 'NO']);
    expect(rgb.pins.map((p) => p.name).sort()).toEqual(['G', 'K', 'R']);
    expect(l.parts.find((p) => p.component === 'LDR1')!.key).toBe('photoresistor');
    expect(l.parts.find((p) => p.component === 'BZ1')!.key).toBe('buzzer');
    expect(partNumber('model.ldr.senba_gl5528')).toBe('GL5528');
    expect(partNumber('model.buzzer.cui_cem_1205_ic')).toBe('CEM-1205-IC');
    expect(partNumber('model.relay.songle_srd_05vdc_sl_c')).toBe('SRD-05VDC-SL-C');
    expect(partNumber('model.rgb_led.kingbright_wp154a4sureqbfzgc')).toBe('WP154A4SUREQBFZGC');
  });
});

describe('Sprint 10 parts: 3D', () => {
  it('each part has its own physical model; the relay is wired at its real pins, leaded parts at their terminals', () => {
    const { doc } = sprint10Circuit();
    const scene = deriveScene(doc);
    const byId = new Map(scene.components.map((c) => [c.id, c]));
    expect(byId.get('D1')!.model).toBe('led.rgb');
    expect(byId.get('LDR1')!.model).toBe('ldr.disc');
    expect(byId.get('BZ1')!.model).toBe('buzzer.can');
    const k = byId.get('K1')!;
    expect(k.model).toBe('relay.cube');
    for (const t of k.terminals) {
      const [px, pz] = RELAY_SRD.pins[t.id]!;
      expect(t.x).toBeCloseTo(k.x + px, 9);
      expect(t.z).toBeCloseTo(k.z + pz, 9);
      expect(t.y).toBe(RELAY_SRD.attachHeightMm);
    }
    // Leaded parts: attach points at the 2D terminal positions (physical scale).
    const p = doc.layout.components.D1!;
    const red = byId.get('D1')!.terminals.find((t) => t.id === 'red')!;
    expect(red.x).toBeCloseTo((p.x - 40) * SCALE, 9);
    expect(red.z).toBeCloseTo((p.y - 20) * SCALE, 9);
    // Every wire ends exactly on its terminal's attach point.
    for (const w of scene.wires) {
      const wd = doc.layout.wires.find((x) => x.id === w.id)!;
      for (const [e, pt] of [
        [wd.from, w.points[0]!],
        [wd.to, w.points.at(-1)!],
      ] as const) {
        if (e.kind !== 'terminal') continue;
        const t = byId.get(e.component)!.terminals.find((x) => x.id === e.terminal)!;
        expect([pt.x, pt.y, pt.z]).toEqual([t.x, t.y, t.z]);
      }
    }
  });
});

describe('Sprint 10 parts: the combined circuit simulates', () => {
  it('toggle open: the relay rests, the buzzer sounds through NC; closed: the red channel lights through NO', () => {
    const { doc } = sprint10Circuit();
    const solve = (closed: boolean) => {
      const d = must(setParam(doc, 'SW1', 'closed', closed)).doc;
      const o = new EngineSession(createSnapshot(d)).solve();
      if (!o.ok) throw new Error(JSON.stringify(o.error));
      return o as SolveSuccess;
    };
    const open = solve(false);
    expect(open.components.K1!.state).toEqual({ energized: false, contact: 'nc' });
    expect(open.components.BZ1!.state).toEqual({ sounding: true });
    expect(Math.abs(open.components.D1!.currents!.red!)).toBeLessThan(1e-9); // NO is open
    expect(open.components.D1!.currents!.green).toBeGreaterThan(1e-4); // fed by the photoresistor
    const closed = solve(true);
    expect(closed.components.K1!.state).toEqual({ energized: true, contact: 'no' });
    expect(closed.components.BZ1!.state).toEqual({ sounding: false });
    // 5 V through the default 1 kOhm: (5 - V_F red) / 1 kOhm, about 3.2 mA.
    expect(closed.components.D1!.currents!.red).toBeGreaterThan(3e-3);
    expect(closed.components.K1!.currents!.coil).toBeCloseTo(5 / 70, 6);
  });
});

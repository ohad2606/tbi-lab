/**
 * Sprint 12 parts (HC-SR04, DHT22, 16x2 I2C LCD), the product side: catalog coverage in every view
 * (2D symbol, schematic block, 3D model), the palette, the LCD presentation contract (the engine's
 * text verbatim, LTR, blank without a result) in 2D and 3D, and the physical 3D attach points.
 */
import { describe, expect, it } from 'vitest';
import type { VNode } from 'preact';
import { CATALOG, type ComponentTypeId } from '@tbi-lab/domain';
import { newDoc } from '../../packages/domain/tests/helpers.js';
import { place, wire } from '../../packages/domain/tests/circuits.js';
import { SYMBOLS, lcdView, lcdCellX, type LcdView } from '../src/ui/symbols.js';
import { PALETTE_GROUPS } from '../src/ui/Palette.js';
import { SCHEMATIC_SYMBOLS } from '../src/views/schematic/symbols.js';
import { schematicLayout } from '../src/views/schematic/layout.js';
import {
  FOOTPRINT,
  MODEL_FOR,
  MODEL_HEIGHT,
  SCALE,
  deriveScene,
  deriveSceneVariant,
  touchingNodes,
} from '../src/views/scene3d/scene.js';
import { DHT22_CASE, HC_SR04_MODULE, LCD1602_MODULE } from '../src/views/scene3d/physical.js';
import { LCD_FACE_PX, paintLcdFace } from '../src/views/scene3d/models.js';
import { ASSETS } from '../src/views/scene3d/assets/manifest.js';

const S12: ComponentTypeId[] = ['sensor.hc_sr04', 'sensor.dht22', 'display.lcd1602_i2c'];

/** Every element of a rendered symbol tree (preact VNodes), depth first. */
function elements(node: unknown): VNode<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const v = node as VNode<Record<string, unknown>>;
  return [v, ...elements(v.props.children)];
}
const texts = (node: unknown) =>
  elements(node)
    .filter((e) => e.type === 'text')
    .map((e) => ({ x: e.props.x as number, y: e.props.y as number, ch: String(e.props.children) }));

/** A 5 V bench with the three parts powered (their signal pins unwired). */
function s12Circuit() {
  let doc = newDoc();
  const ids: Record<string, string> = { psu: 'PSU1', g1: 'GND1' };
  for (const [k, type, x, y] of [
    ['us', 'sensor.hc_sr04', 400, 0],
    ['dht', 'sensor.dht22', 400, 460],
    ['lcd', 'display.lcd1602_i2c', 400, 900],
  ] as const) {
    const r = place(doc, type, x, y);
    doc = r.doc;
    ids[k] = r.id;
  }
  const w = (a: [string, string], b: [string, string]) => (doc = wire(doc, a, b));
  w([ids.psu!, 'negative'], [ids.g1!, 'ref']);
  w([ids.psu!, 'positive'], [ids.us!, 'vcc']);
  w([ids.us!, 'gnd'], [ids.g1!, 'ref']);
  w([ids.psu!, 'positive'], [ids.dht!, 'vdd']);
  w([ids.dht!, 'gnd'], [ids.g1!, 'ref']);
  w([ids.psu!, 'positive'], [ids.lcd!, 'vcc']);
  w([ids.lcd!, 'gnd'], [ids.g1!, 'ref']);
  return { doc, ids };
}

describe('Sprint 12 parts: every view has them', () => {
  it('2D symbols contain their terminals; schematic blocks name every terminal once; 3D models exist', () => {
    for (const type of S12) {
      const def = CATALOG[type];
      const [x0, y0, x1, y1] = SYMBOLS[type].bbox;
      for (const t of def.terminals) {
        // On the 20-unit layout grid, as every part's terminals (the board's pin rows included).
        expect(Math.abs(t.offset.x % 20), `${type}.${t.id}`).toBe(0);
        expect(Math.abs(t.offset.y % 20), `${type}.${t.id}`).toBe(0);
        expect(
          t.offset.x >= x0 && t.offset.x <= x1 && t.offset.y >= y0 && t.offset.y <= y1,
          `${type}.${t.id}`,
        ).toBe(true);
        // The symbol's lead starts exactly on the terminal.
        expect(
          elements(SYMBOLS[type].draw()).some(
            (e) => e.type === 'line' && e.props.x1 === t.offset.x && e.props.y1 === t.offset.y,
          ),
          `${type}.${t.id} lead`,
        ).toBe(true);
      }
      const sch = SCHEMATIC_SYMBOLS[type];
      expect(sch.kind).toBe('module');
      if (sch.kind === 'module')
        expect(sch.pins.map((p) => p.terminal).sort()).toEqual(
          def.terminals.map((t) => t.id).sort(),
        );
      const model = MODEL_FOR[type]!;
      expect(model).toBeDefined();
      expect(ASSETS[model].model).toBe(model);
    }
    expect(MODEL_FOR['display.lcd1602_i2c']).toBe('display.lcd1602');
    expect(ASSETS['display.lcd1602'].live).toEqual(['lcdFace']);
  });

  it('the palette offers the sensors with the sensors and the display with the outputs', () => {
    const group = (type: ComponentTypeId) =>
      PALETTE_GROUPS.find((g) => g.types.includes(type))?.key;
    expect(group('sensor.hc_sr04')).toBe('palette.group.sensors');
    expect(group('sensor.dht22')).toBe('palette.group.sensors');
    expect(group('display.lcd1602_i2c')).toBe('palette.group.output');
    const listed = PALETTE_GROUPS.flatMap((g) => g.types);
    for (const type of S12) expect(listed.filter((t) => t === type)).toHaveLength(1);
  });

  it('the schematic draws each part as a block with its glyph and pin names', () => {
    const { doc, ids } = s12Circuit();
    const l = schematicLayout(doc);
    const block = (id: string) => l.modules.find((m) => m.component === id)!;
    expect(block(ids.us!).glyph).toBe('ultrasonic');
    expect(block(ids.dht!).glyph).toBe('dht22');
    expect(block(ids.lcd!).glyph).toBe('lcd');
    expect(
      block(ids.us!)
        .pins.map((p) => p.name)
        .sort(),
    ).toEqual(['GND', 'VCC']);
    expect(
      block(ids.lcd!)
        .pins.map((p) => p.name)
        .sort(),
    ).toEqual(['GND', 'VCC']);
  });
});

describe('Sprint 12: the LCD shows exactly the engine result', () => {
  const lines = ['Hello, world!   ', 'T=21.5°C ｱ�   '] as const;

  it('lcdView reads the result contract and invents nothing', () => {
    expect(lcdView(undefined)).toBeUndefined();
    // Not an LCD result (no text lines): no display state.
    expect(lcdView({ powered: true, output: 'high' })).toBeUndefined();
    expect(
      lcdView({
        powered: true,
        backlight: true,
        displayOn: true,
        line1: lines[0],
        line2: lines[1],
      }),
    ).toEqual({ backlight: true, displayOn: true, lines });
    // Unpowered: dark and blank whatever the controller state says.
    expect(
      lcdView({
        powered: false,
        backlight: true,
        displayOn: true,
        line1: lines[0],
        line2: lines[1],
      }),
    ).toEqual({ backlight: false, displayOn: false, lines });
  });

  it('2D: each character verbatim in its cell, left to right; blank without a result', () => {
    const sym = SYMBOLS['display.lcd1602_i2c'];
    expect(texts(sym.draw())).toEqual([]);
    expect(texts(sym.draw({ lcd: { backlight: false, displayOn: false, lines } }))).toEqual([]);
    const on: LcdView = { backlight: true, displayOn: true, lines };
    const drawn = texts(sym.draw({ lcd: on }));
    // Spaces leave their cell empty; every other character is drawn as given (the ROM's katakana
    // and the engine's U+FFFD included), in its own cell.
    const expected = lines.flatMap((line, row) =>
      Array.from(line).flatMap((ch, i) => (ch === ' ' ? [] : [{ row, i, ch }])),
    );
    expect(drawn.map((d) => d.ch)).toEqual(expected.map((e) => e.ch));
    expected.forEach((e, k) => expect(drawn[k]!.x).toBeCloseTo(lcdCellX(e.i), 9));
    // Line 1 above line 2; within a line strictly left to right.
    for (let k = 1; k < drawn.length; k++)
      if (expected[k]!.row === expected[k - 1]!.row)
        expect(drawn[k]!.x).toBeGreaterThan(drawn[k - 1]!.x);
      else expect(drawn[k]!.y).toBeGreaterThan(drawn[k - 1]!.y);
    // The text group is LTR in every locale.
    const group = elements(sym.draw({ lcd: on })).find((e) => e.props.class === 'lcd-text')!;
    expect(group.props.direction).toBe('ltr');
    // The window is lit only by the reported backlight.
    const lit = (v: LcdView) =>
      elements(sym.draw({ lcd: v })).some((e) => String(e.props.class ?? '').includes('lcd-lit'));
    expect(lit(on)).toBe(true);
    expect(lit({ ...on, backlight: false })).toBe(false);
  });

  it('3D: the face paints the same characters into their cells, lit only by the backlight', () => {
    const calls: { op: string; args: unknown[]; fill: string }[] = [];
    const ctx = {
      fillStyle: '',
      font: '',
      textAlign: '',
      textBaseline: '',
      direction: '',
      fillRect(...args: unknown[]) {
        calls.push({ op: 'rect', args, fill: this.fillStyle });
      },
      fillText(...args: unknown[]) {
        calls.push({ op: 'text', args, fill: this.fillStyle });
      },
    };
    const [w, h] = LCD_FACE_PX;
    const paint = (v: LcdView | undefined) => {
      calls.length = 0;
      paintLcdFace(ctx as unknown as CanvasRenderingContext2D, w, h, v);
      return calls;
    };
    // Blank: an unlit panel and its 32 empty cells, no character.
    let c = paint(undefined);
    expect(c.filter((x) => x.op === 'text')).toEqual([]);
    expect(c.filter((x) => x.op === 'rect')).toHaveLength(33);
    expect(c[0]!.fill).toBe('#3a4130');
    c = paint({ backlight: true, displayOn: true, lines });
    expect(c[0]!.fill).toBe('#a9c94a');
    expect(ctx.direction).toBe('ltr');
    const chars = c.filter((x) => x.op === 'text');
    expect(chars.map((x) => x.args[0])).toEqual(
      lines.flatMap((l) => Array.from(l).filter((ch) => ch !== ' ')),
    );
    // Cells at the datasheet pitch (3.65 mm), centred in the 64.5 mm viewing area.
    const P = LCD1602_MODULE;
    const px = (mm: number) => (mm * w) / P.viewXMm;
    expect(chars[0]!.args[1]).toBeCloseTo(px((P.viewXMm - P.activeXMm) / 2 + P.charXMm / 2), 6);
    expect((chars[1]!.args[1] as number) - (chars[0]!.args[1] as number)).toBeCloseTo(
      px(P.charPitchXMm),
      6,
    );
    // Display off (HD44780 D = 0): the backlight may be on, the characters are not shown.
    expect(paint({ backlight: true, displayOn: false, lines }).some((x) => x.op === 'text')).toBe(
      false,
    );
  });
});

describe('Sprint 12 parts: 3D', () => {
  it('signal pins wired too: wires reach the real pins and touch nothing of another node', () => {
    const fixture = s12Circuit();
    const ids = fixture.ids;
    let doc = fixture.doc;
    // A series resistor beside each signal pin (TRIG, ECHO, DATA, SDA, SCL).
    for (const [part, term, y] of [
      [ids.us!, 'trig', -20],
      [ids.us!, 'echo', 0],
      [ids.dht!, 'data', 440],
      [ids.lcd!, 'sda', 900],
      [ids.lcd!, 'scl', 920],
    ] as const) {
      const r = place(doc, 'component.resistor', 220, y);
      doc = wire(r.doc, [part, term], [r.id, 'b']);
    }
    for (const separate of [true, false])
      for (const router of ['fresh', 'legacy'] as const) {
        const scene = deriveSceneVariant(doc, separate, router);
        expect(scene.wires).toHaveLength(doc.layout.wires.length);
        expect(touchingNodes(scene), `${separate} ${router}`).toEqual([]);
      }
  });

  it('upright modules attach at their real header pins; the LCD at its backpack header tips', () => {
    const { doc, ids } = s12Circuit();
    const scene = deriveScene(doc);
    const byId = new Map(scene.components.map((c) => [c.id, c]));
    const check = (
      id: string,
      pins: Record<string, readonly [number, number]>,
      y: number,
      model: string,
    ) => {
      const c = byId.get(id)!;
      expect(c.model).toBe(model);
      expect(c.terminals.map((t) => t.id).sort()).toEqual(Object.keys(pins).sort());
      for (const t of c.terminals) {
        const [px, pz] = pins[t.id]!;
        expect(t.x).toBeCloseTo(c.x + px, 9);
        expect(t.z).toBeCloseTo(c.z + pz, 9);
        expect(t.y).toBe(y);
      }
    };
    check(ids.us!, HC_SR04_MODULE.pins, HC_SR04_MODULE.attachHeightMm, 'sensor.ultrasonic');
    check(ids.dht!, DHT22_CASE.pins, DHT22_CASE.attachHeightMm, 'sensor.dht22');
    check(ids.lcd!, LCD1602_MODULE.pins, LCD1602_MODULE.pinHeightMm, 'display.lcd1602');
    // The LCD's pin tips are on its 2D terminal column; header order as on the backpack.
    expect(LCD1602_MODULE.pinTipXMm).toBeCloseTo(
      CATALOG['display.lcd1602_i2c'].terminals[0]!.offset.x * SCALE,
      9,
    );
    const z = (id: string) => LCD1602_MODULE.pins[id]![1];
    expect(z('gnd') < z('vcc') && z('vcc') < z('sda') && z('sda') < z('scl')).toBe(true);
    // Each physical header is centred where the 2D pins are (along z), at the real 2.54 mm pitch.
    for (const [type, pins] of [
      ['sensor.hc_sr04', HC_SR04_MODULE.pins],
      ['sensor.dht22', DHT22_CASE.pins],
      ['display.lcd1602_i2c', LCD1602_MODULE.pins],
    ] as const) {
      const ys = CATALOG[type].terminals.map((t) => t.offset.y * SCALE);
      const zs = CATALOG[type].terminals.map((t) => pins[t.id]![1]);
      const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
      expect(mean(zs)).toBeCloseTo(mean(ys), 9);
      zs.slice(1).forEach((z, i) => expect(z - zs[i]!).toBeCloseTo(2.54, 9));
    }
    // Physical envelopes from the documents.
    expect(FOOTPRINT['sensor.ultrasonic'][3] - FOOTPRINT['sensor.ultrasonic'][2]).toBeCloseTo(
      45,
      9,
    );
    expect(FOOTPRINT['sensor.ultrasonic'][1] - FOOTPRINT['sensor.ultrasonic'][0]).toBeCloseTo(
      15,
      9,
    );
    expect(MODEL_HEIGHT['sensor.ultrasonic'] - HC_SR04_MODULE.standoffMm).toBeCloseTo(20, 9);
    expect(FOOTPRINT['sensor.dht22'][3] - FOOTPRINT['sensor.dht22'][2]).toBeCloseTo(15.1, 9);
    expect(FOOTPRINT['sensor.dht22'][1] - FOOTPRINT['sensor.dht22'][0]).toBeCloseTo(7.7, 9);
    expect(MODEL_HEIGHT['sensor.dht22'] - DHT22_CASE.standoffMm).toBeCloseTo(25.1, 9);
    expect(FOOTPRINT['display.lcd1602'][1] - FOOTPRINT['display.lcd1602'][0]).toBeCloseTo(80, 9);
    expect(FOOTPRINT['display.lcd1602'][3] - FOOTPRINT['display.lcd1602'][2]).toBeCloseTo(36, 9);
    // Every wire ends on its terminal's attach point, and nothing of different nodes touches.
    for (const w of scene.wires) {
      const src = doc.layout.wires.find((x) => x.id === w.id)!;
      for (const [end, p] of [
        [src.from, w.points[0]!],
        [src.to, w.points.at(-1)!],
      ] as const) {
        if (end.kind !== 'terminal') continue;
        const t = byId.get(end.component)!.terminals.find((x) => x.id === end.terminal)!;
        expect(p.x).toBeCloseTo(t.x, 6);
        expect(p.z).toBeCloseTo(t.z, 6);
      }
    }
    expect(touchingNodes(scene)).toEqual([]);
  });
});

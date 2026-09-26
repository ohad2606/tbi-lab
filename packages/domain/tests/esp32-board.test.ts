/**
 * Sprint 6: the Classic ESP32 DevKitC catalog item, the curated firmware list and the circuit
 * checks around a board.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CATALOG,
  ESP32_DEVKITC_WROOM32,
  FIRMWARE_ARTIFACTS,
  NO_FIRMWARE,
  addComponent,
  addWire,
  boardTerminalId,
  checkCircuit,
  classifyEdit,
  setParam,
  validateProject,
  type ProjectDocument,
} from '../src/index.js';
import { must, newDoc } from './helpers.js';

const BOARD = 'board.esp32_devkitc_wroom32';

describe('Classic ESP32 DevKitC catalog item', () => {
  it('connectable terminals are exactly the runtime-supported pads and one GND', () => {
    const ids = CATALOG[BOARD].terminals.map((t) => t.id).sort();
    const supported = ESP32_DEVKITC_WROOM32.pins
      .filter((p) => p.gpio !== null && p.simulatorSupport !== 'none')
      .map((p) => `gpio${p.gpio}`);
    expect(ids).toEqual([...supported, 'gnd'].sort());
    // V1 policy from the R1 map: flash, console, supplies and EN are never connectable.
    for (const gpio of [6, 7, 8, 9, 10, 11, 1, 3]) expect(ids).not.toContain(`gpio${gpio}`);
    for (const gpio of [34, 35, 36, 39, 32, 33, 0, 2, 5, 12, 15, 4, 16, 27])
      expect(ids).toContain(`gpio${gpio}`);
    // Every terminal sits on the grid, on the board edge, and has a translation key.
    for (const t of CATALOG[BOARD].terminals) {
      expect(Math.abs(t.offset.x)).toBe(80);
      expect(Math.abs(t.offset.y % 20)).toBe(0);
      expect(t.labelKey).toMatch(/^pin\./);
    }
    expect(CATALOG[BOARD].groundTerminal).toBe('gnd');
    expect(boardTerminalId(ESP32_DEVKITC_WROOM32.pins.find((p) => p.gpio === 9)!)).toBeUndefined();
  });

  it('the firmware choice is a language-neutral content identity, not live while running', () => {
    const def = CATALOG[BOARD].params.find((p) => p.key === 'firmware')!;
    expect(def.kind).toBe('enum');
    expect(def.live).toBeFalsy();
    const values = def.kind === 'enum' ? def.options.map((o) => o.value) : [];
    expect(values[0]).toBe(NO_FIRMWARE);
    for (const v of values.slice(1)) expect(v).toMatch(/^[0-9a-f]{64}$/);
    let doc = newDoc();
    const r = must(addComponent(doc, BOARD, { x: 300, y: 0 }));
    doc = r.doc;
    expect(doc.components.find((c) => c.id === r.id)!.params.firmware).toBe(NO_FIRMWARE);
    const next = must(setParam(doc, r.id, 'firmware', FIRMWARE_ARTIFACTS[0]!.sha256)).doc;
    expect(validateProject(next)).toEqual([]);
    expect(classifyEdit(doc, next)).toBe('structural'); // Stop first, like a resistor value
    expect(setParam(doc, r.id, 'firmware', 'deadbeef').ok).toBe(false);
  });

  it('the curated firmware identities are exactly the pinned R1 artifacts', () => {
    const lock = JSON.parse(
      readFileSync(
        new URL('../../../runtime/firmware/artifacts.lock.json', import.meta.url),
        'utf8',
      ),
    ) as { artifacts: Record<string, { sha256: string }> };
    expect(FIRMWARE_ARTIFACTS.find((f) => f.id === 'tbi-gpio-proof')!.sha256).toBe(
      lock.artifacts.TbiGpioProof!.sha256,
    );
    expect(FIRMWARE_ARTIFACTS.find((f) => f.id === 'tbi-banks')!.sha256).toBe(
      lock.artifacts.TbiBanks!.sha256,
    );
    for (const f of FIRMWARE_ARTIFACTS) {
      expect(f.board).toBe(BOARD);
      expect(f.features).toEqual({ internalPull: [], gpioInterrupt: [] });
    }
  });
});

describe('circuit checks around a board', () => {
  function board(): { doc: ProjectDocument; u: string; r: string } {
    let doc = newDoc();
    const u = must(addComponent(doc, BOARD, { x: 300, y: 0 }));
    doc = u.doc;
    const r = must(addComponent(doc, 'component.resistor', { x: 480, y: 100 }));
    doc = r.doc;
    return { doc, u: u.id, r: r.id };
  }

  it('unused board pins are normal; the board GND is a circuit reference', () => {
    const b = board();
    const { u, r } = b;
    let doc = b.doc;
    doc = must(
      addWire(
        doc,
        { kind: 'terminal', component: u, terminal: 'gpio2' },
        { kind: 'terminal', component: r, terminal: 'a' },
      ),
    ).doc;
    doc = must(
      addWire(
        doc,
        { kind: 'terminal', component: r, terminal: 'b' },
        { kind: 'terminal', component: u, terminal: 'gnd' },
      ),
    ).doc;
    const issues = checkCircuit(doc).filter((i) => !i.components.includes('PSU1'));
    expect(issues.filter((i) => i.code === 'partially_wired' && i.components.includes(u))).toEqual(
      [],
    );
    expect(issues.filter((i) => i.code === 'no_ground')).toEqual([]);
    expect(issues.filter((i) => i.code === 'floating_island')).toEqual([]);
  });

  it('a part driven by a pad is referenced through the MCU, not floating', () => {
    const b = board();
    const { u, r } = b;
    let doc = b.doc;
    const g = must(addComponent(doc, 'component.ground', { x: 600, y: 200 }));
    doc = g.doc;
    doc = must(
      addWire(
        doc,
        { kind: 'terminal', component: u, terminal: 'gpio4' },
        { kind: 'terminal', component: r, terminal: 'a' },
      ),
    ).doc;
    doc = must(
      addWire(
        doc,
        { kind: 'terminal', component: u, terminal: 'gnd' },
        { kind: 'terminal', component: g.id, terminal: 'ref' },
      ),
    ).doc;
    // R's far end is unwired (partial), but nothing is floating: its wired end is a pad node.
    expect(checkCircuit(doc).some((i) => i.code === 'floating_island')).toBe(false);
  });
});

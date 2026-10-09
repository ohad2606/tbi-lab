/**
 * I2C devices of the Session Host (Sprint 12, R3; ADR-011 §4). The ESP32 I2C controller's bus
 * phases arrive as `B` frames (patch 0008); each I2C part in the circuit is an engine target
 * (peripherals/hd44780.ts: PCF8574 backpack + HD44780) answering them.
 *
 * Electrical gating at every START, from the circuit and the solved operating point, never
 * assumed: a target can acknowledge only if
 * - the pads the firmware routed to this controller's SDA and SCL (`F` frames) are on the
 *   target's SDA and SCL nets (swapped lines: `i2c_wiring`);
 * - both lines idle high through a pull-up the solver sees, at the target (PCF8574 V_IH = 0.7 VDD)
 *   and at the ESP32 pads (V_IH), with the pads released (no pull-up: `i2c_no_pullup`; internal
 *   pad pull-ups are not modelled and do not count, PM D-4);
 * - the target is powered.
 * Otherwise nothing acknowledges, exactly as on a real bus. Two targets with the same address on
 * one bus refuse the session before it starts (`i2c_address_conflict`).
 *
 * Phases per simulated second are bounded (`i2c_rate_exceeded`, then NACK); at the bus timing of
 * patch 0008 a real 100 kHz bus moves about 11 000 bytes per second.
 */
import {
  I2cLcd,
  PCF8574_VIH_FRACTION,
  PCF8574_VIL_FRACTION,
  V_IH_V,
  type SolveSuccess,
} from '@tbi-lab/engine';
import type { SimulationSnapshot } from '@tbi-lab/domain';
import type { McuAttachmentRequest } from './protocol.js';
import type { I2cPhase, PadFunction } from '../harness/protocol.js';

export const I2C_PHASE_BUDGET_PER_SIM_S = 50_000;
export const I2C_TYPES = ['display.lcd1602_i2c'] as const;

export interface I2cDiagnostic {
  code: 'i2c_no_pullup' | 'i2c_logic_level' | 'i2c_wiring' | 'i2c_rate_exceeded';
  severity: 'warning';
  detail: Record<string, unknown>;
}

interface Lcd {
  id: string;
  address: number;
  lcd: I2cLcd;
  powered: boolean;
  sdaNet: string | null;
  sclNet: string | null;
}

const addressOf = (v: unknown): number | null => {
  const m = typeof v === 'string' ? /^i2c\.0x([0-7][0-9a-f])$/.exec(v) : null;
  return m ? Number.parseInt(m[1]!, 16) : null;
};

/** Two I2C parts at one address on one SDA net (they would answer together). */
export function i2cAddressConflict(snapshot: SimulationSnapshot): string[] | null {
  const seen = new Map<string, string>();
  for (const c of snapshot.components) {
    if (!(I2C_TYPES as readonly string[]).includes(c.type)) continue;
    const net = snapshot.connections.find((x) => x.component === c.id && x.terminal === 'sda')?.net;
    const key = `${net ?? `unwired:${c.id}`}|${String(c.params.address)}`;
    const other = seen.get(key);
    if (other && net) return [other, c.id];
    seen.set(key, c.id);
  }
  return null;
}

export class I2cDevices {
  private readonly lcds: Lcd[] = [];
  /** Pads routed to each controller's lines (from F frames). */
  private readonly lines = new Map<string, number>();
  /** The addressed target per bus between START and STOP. */
  private readonly current = new Map<number, Lcd | null>();
  private readonly noted = new Set<string>();
  private window = -1n;
  private used = 0;
  readonly diagnostics: { simNs: bigint; d: I2cDiagnostic }[] = [];
  /** Parts whose display or backlight changed since the last publish. */
  readonly changed = new Set<string>();

  constructor(
    private readonly snapshot: SimulationSnapshot,
    private readonly attachments: readonly McuAttachmentRequest[],
  ) {
    const netOf = (component: string, terminal: string) =>
      snapshot.connections.find((x) => x.component === component && x.terminal === terminal)?.net ??
      null;
    for (const c of snapshot.components) {
      if (c.type !== 'display.lcd1602_i2c') continue;
      const address = addressOf(c.params.address) ?? 0x27;
      this.lcds.push({
        id: c.id,
        address,
        lcd: new I2cLcd(address),
        powered: false,
        sdaNet: netOf(c.id, 'sda'),
        sclNet: netOf(c.id, 'scl'),
      });
    }
  }

  get empty(): boolean {
    return this.lcds.length === 0;
  }

  private padNet(pad: number): string | null {
    const a = this.attachments.find((x) => x.gpio === pad);
    if (!a) return null;
    return (
      this.snapshot.connections.find(
        (x) => x.component === a.component && x.terminal === a.terminal,
      )?.net ?? null
    );
  }

  /** A pad's routed function changed (F frame). */
  onFunc(pad: number, func: PadFunction): void {
    for (const [k, p] of this.lines) if (p === pad) this.lines.delete(k);
    if (/^i2c[01]-(sda|scl)$/.test(func)) this.lines.set(func, pad);
  }

  private note(simNs: bigint, d: I2cDiagnostic, once: string) {
    if (this.noted.has(once)) return;
    this.noted.add(once);
    this.diagnostics.push({ simNs, d });
  }

  /** Whether `t` can acknowledge on `bus` given the wiring and the operating point. */
  private present(vns: bigint, bus: 0 | 1, t: Lcd, out: SolveSuccess | null): boolean {
    const sdaPad = this.lines.get(`i2c${bus}-sda`);
    const sclPad = this.lines.get(`i2c${bus}-scl`);
    if (sdaPad === undefined || sclPad === undefined || !out) return false;
    const sdaNet = this.padNet(sdaPad);
    const sclNet = this.padNet(sclPad);
    if (sdaNet !== t.sdaNet || sclNet !== t.sclNet) {
      if (sdaNet !== null && (sdaNet === t.sclNet || sclNet === t.sdaNet))
        this.note(
          vns,
          {
            code: 'i2c_wiring',
            severity: 'warning',
            detail: { component: t.id, sda: sdaPad, scl: sclPad, reason: 'swapped' },
          },
          `wiring:${t.id}`,
        );
      return false;
    }
    const r = out.components[t.id];
    if (r?.state?.powered !== true) return false;
    const gnd = r.terminals.gnd!;
    const vcc = r.terminals.vcc! - gnd;
    const pad = (gpio: number) => out.pins?.find((p) => p.gpio === gpio)?.voltage ?? 0;
    // Idle (released) line levels: at the target against the PCF8574's V_IH / V_IL, and at the
    // ESP32 pad against its V_IH. Below V_IL there is no pull-up; in between the level is out of
    // specification (e.g. 3.3 V pull-ups for a 5 V module: 3.3 V < 0.7 x 5 V).
    const problems: Record<string, unknown>[] = [];
    let noPullUp = true;
    for (const [line, gpio] of [
      ['sda', sdaPad],
      ['scl', sclPad],
    ] as const) {
      const v = r.terminals[line] == null ? 0 : r.terminals[line]! - gnd;
      const atPad = pad(gpio);
      const need = PCF8574_VIH_FRACTION * vcc;
      if (v >= need && atPad >= V_IH_V) continue;
      if (v > PCF8574_VIL_FRACTION * vcc) noPullUp = false;
      problems.push({
        line,
        gpio,
        volts: v,
        padVolts: atPad,
        requiredVolts: need,
        padRequiredVolts: V_IH_V,
      });
    }
    if (problems.length) {
      const code = noPullUp ? 'i2c_no_pullup' : 'i2c_logic_level';
      this.note(
        vns,
        { code, severity: 'warning', detail: { component: t.id, lines: problems } },
        `${code}:${t.id}`,
      );
      return false;
    }
    return true;
  }

  /**
   * One bus phase; `out` is the latest operating point (pads released). Returns the reply value:
   * S/W acknowledge (boolean), R the byte, P nothing.
   */
  phase(vns: bigint, bus: 0 | 1, p: I2cPhase, out: SolveSuccess | null): boolean | number | null {
    const w = vns / 1_000_000_000n;
    if (w !== this.window) {
      this.window = w;
      this.used = 0;
    }
    if (++this.used > I2C_PHASE_BUDGET_PER_SIM_S) {
      this.note(
        vns,
        { code: 'i2c_rate_exceeded', severity: 'warning', detail: { bus, window: w.toString() } },
        `rate:${w}`,
      );
      this.current.set(bus, null);
      return p.op === 'R' ? 0xff : p.op === 'P' ? null : false;
    }
    if (p.op === 'S') {
      const t = this.lcds.find((x) => x.address === p.addr) ?? null;
      const ok = t !== null && this.present(vns, bus, t, out);
      this.current.set(bus, ok ? t : null);
      return ok;
    }
    const t = this.current.get(bus) ?? null;
    if (p.op === 'P') {
      this.current.set(bus, null);
      return null;
    }
    if (p.op === 'W') {
      if (!t) return false;
      const before = this.view(t);
      t.lcd.expander.writeByte(p.byte);
      if (this.view(t) !== before) this.changed.add(t.id);
      return true;
    }
    // A read with no target addressed sees the released bus.
    return t ? t.lcd.expander.readByte() : 0xff;
  }

  /**
   * The backpack's P3 drives the backlight. At power-on the PCF8574 port is all ones (NXP p.6:
   * weak high), so the backlight is on until the firmware writes P3 = 0.
   */
  private lit(t: Lcd): boolean {
    return t.powered && ((t.lcd.expander.latch >> 3) & 1) === 1;
  }

  private view(t: Lcd): string {
    const c = t.lcd.controller;
    return `${this.lit(t)}|${c.displayOn}|${t.lcd.text().join('|')}`;
  }

  /**
   * Follow each module's supply from a solved operating point: a module that loses power loses
   * its state (the controller and the expander power up again from reset). Returns the parts whose
   * backlight token changed (the engine's runtime input).
   */
  power(out: SolveSuccess): { id: string; backlight: 'on' | 'off' }[] {
    const changes: { id: string; backlight: 'on' | 'off' }[] = [];
    for (const t of this.lcds) {
      const before = this.lit(t);
      const on = out.components[t.id]?.state?.powered === true;
      if (on && !t.powered) t.lcd = new I2cLcd(t.address);
      t.powered = on;
      if (this.lit(t) !== before) {
        changes.push({ id: t.id, backlight: this.lit(t) ? 'on' : 'off' });
        this.changed.add(t.id);
      }
    }
    return changes;
  }

  /** Backlight token per LCD part (the engine's runtime input). */
  backlight(id: string): 'on' | 'off' {
    const t = this.lcds.find((x) => x.id === id);
    return t && this.lit(t) ? 'on' : 'off';
  }

  /** The display state the browser shows, per LCD part (merged into the part's result). */
  displayState(): Record<string, Record<string, boolean | string>> {
    const out: Record<string, Record<string, boolean | string>> = {};
    for (const t of this.lcds) {
      const [line1 = '', line2 = ''] = t.lcd.text();
      out[t.id] = {
        backlight: this.lit(t),
        displayOn: t.powered && t.lcd.controller.displayOn,
        line1,
        line2,
      };
    }
    return out;
  }
}

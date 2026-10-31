/**
 * Runtime devices (Sprint 12, R2; ADR-011 §2): the HC-SR04 and DHT22 as the Session Host drives
 * them through scheduled inputs (`J`). Protocol TIMING comes from the engine's peripheral models
 * (hcsr04Echo, dht22Frame/dht22Waveform); every LEVEL the firmware will read comes from the
 * electrical solution: for each output state of the sensor the circuit is solved and each attached
 * pad's voltage is interpreted with interpretDigitalInput, exactly as for any other input. Supply,
 * wiring, pull-ups and dividers all act; nothing is assumed to be a logic 1.
 *
 * A response is one reply: every edge is scheduled at once, at its exact virtual time. The host
 * keeps the matching timeline of the sensor's output state and applies it to the engine before
 * each later solve, so the published operating point and any later injection agree with what QEMU
 * applies.
 *
 * Honest limits (documented in the part notes):
 * - HC-SR04: a trigger while the previous echo is still pending is ignored (the module is busy);
 *   the datasheet recommends a cycle over 60 ms but specifies nothing shorter, so nothing else is
 *   invented. Out of range (< 2 cm, > 4 m) or a trigger shorter than 10 us: no echo.
 * - DHT22: answers a start signal (DATA held low >= 1 ms, then released) only when powered for
 *   >= 1 s and >= 2 s after its previous answer (AM2302 sheet p.2, p.3). T_go, from the host's
 *   release to the sensor's response, is 30 us: the midpoint of the sheet's 20-40 us (D-7,
 *   assumption A-R2-2). The sensor reads DATA with CMOS thresholds 0.3/0.7 x VDD (A-R2-8: the sheet
 *   gives none).
 * - Contention: if the firmware drives a pad that has scheduled edges pending, they are cancelled
 *   (`X`), `pad_contention` is reported, and from then on that pad's level comes from the solve at
 *   each frame (as for any input).
 */
import {
  DHT22_DC,
  EngineSession,
  dht22Frame,
  dht22Waveform,
  hcsr04Echo,
  hcsr04TrigLevel,
  interpretDigitalInput,
  V_IH_V,
  V_IL_V,
  type DigitalLevel,
  type SolveSuccess,
} from '@tbi-lab/engine';
import type { SimulationSnapshot } from '@tbi-lab/domain';
import type { Capability, Command, InputSchedule } from '../harness/protocol.js';

/** Scheduled input edges allowed per session per simulated second (T-SEC-2). */
export const J_BUDGET_PER_SIM_S = 4096;
/** DHT22 T_go (A-R2-2): midpoint of the AM2302 sheet's 20-40 us. */
export const DHT22_TGO_NS = 30_000n;
/** DHT22: minimum start-signal low time (AM2302 sheet p.4: "1ms minimum"). */
export const DHT22_START_MIN_NS = 1_000_000n;
/** DHT22: collecting period (sheet p.3 "must beyond 2 seconds") and power-up quiet time (p.2). */
export const DHT22_PERIOD_NS = 2_000_000_000n;
export const DHT22_POWER_UP_NS = 1_000_000_000n;

const CMOS_LOW = 0.3;
const CMOS_HIGH = 0.7;

export const RUNTIME_DEVICE_TYPES: Record<string, readonly Capability[]> = {
  'sensor.hc_sr04': ['sched-input'],
  'sensor.dht22': ['sched-input'],
  'display.lcd1602_i2c': ['i2c', 'pad-func'],
  // Sprint 15 (R4): a servo is driven by an LEDC waveform (Runtime v3).
  'component.servo_sg90': ['pwm', 'pad-func'],
};

export interface DeviceDiagnostic {
  code: 'pad_contention' | 'input_schedule_full' | 'sensor_no_response';
  severity: 'warning' | 'error';
  detail: Record<string, unknown>;
}

interface PartEvent {
  atNs: bigint;
  component: string;
  key: string;
  token: string;
  /** Pad levels QEMU applies at this time (scheduled with J). */
  levels: Map<number, DigitalLevel>;
}

interface Sonar {
  id: string;
  trig: DigitalLevel;
  riseNs: bigint | null;
  busyUntil: bigint;
}

interface Dht {
  id: string;
  line: DigitalLevel;
  lowSince: bigint | null;
  poweredSince: bigint | null;
  lastAnswer: bigint | null;
  busyUntil: bigint;
}

export class RuntimeDevices {
  private readonly sonars: Sonar[] = [];
  private readonly dhts: Dht[] = [];
  private events: PartEvent[] = [];
  private budgetWindow = -1n;
  private budgetUsed = 0;
  readonly diagnostics: { simNs: bigint; d: DeviceDiagnostic }[] = [];
  /**
   * Sprint 25 closure: a response that would put a pad the firmware may read between V_IL and
   * V_IH (the ESP32 specifies no hysteresis there). The response is not given; the session ends.
   */
  undefinedLevel: { gpio: number; voltage: number; component: string } | null = null;

  constructor(
    snapshot: SimulationSnapshot,
    private readonly engine: EngineSession,
    private readonly pads: readonly number[],
    private readonly inputLevels: Map<number, DigitalLevel>,
    private readonly schedule: InputSchedule,
    /** Sprint 25 closure: whether the firmware may read `pad` (Runtime v5 input-read watch). */
    private readonly watched: (pad: number) => boolean = () => false,
  ) {
    for (const c of snapshot.components) {
      if (c.type === 'sensor.hc_sr04')
        this.sonars.push({ id: c.id, trig: 0, riseNs: null, busyUntil: -1n });
      if (c.type === 'sensor.dht22')
        this.dhts.push({
          id: c.id,
          line: 1,
          lowSince: null,
          poweredSince: null,
          lastAnswer: null,
          busyUntil: -1n,
        });
    }
  }

  get empty(): boolean {
    return this.sonars.length === 0 && this.dhts.length === 0;
  }

  /** Apply every sensor output change QEMU has applied by `vns` (before any solve at `vns`). */
  advance(vns: bigint): void {
    while (this.events.length && this.events[0]!.atNs <= vns) {
      const e = this.events.shift()!;
      this.engine.setPartRuntime(e.component, e.key, e.token);
      for (const [pad, level] of e.levels) this.inputLevels.set(pad, level);
    }
  }

  /** Whether a sensor output change is due by `vns` (not yet applied). */
  dueBy(vns: bigint): boolean {
    return this.events.length > 0 && this.events[0]!.atNs <= vns;
  }

  /** Whether `pad` has scheduled edges still to come. */
  pending(pad: number): boolean {
    return this.events.some((e) => e.levels.has(pad));
  }

  /**
   * The firmware drives `pad` while edges are pending on it: cancel them (ADR-011 §2). The
   * sensor's own output timeline continues (it is still driving); only the pad's schedule ends.
   */
  contention(vns: bigint, pad: number): Command[] {
    if (!this.pending(pad)) return [];
    for (const e of this.events) e.levels.delete(pad);
    this.note(vns, {
      code: 'pad_contention',
      severity: 'warning',
      detail: { gpio: pad, components: this.owners(pad) },
    });
    return [{ type: 'X', pad }];
  }

  private owners(pad: number): string[] {
    return [...new Set(this.events.filter((e) => e.levels.has(pad)).map((e) => e.component))];
  }

  private note(simNs: bigint, d: DeviceDiagnostic) {
    this.diagnostics.push({ simNs, d });
  }

  /**
   * After a solve at frame time `vns`: what the sensors saw on their inputs. Returns the `J`
   * commands of every response this frame starts.
   */
  observe(vns: bigint, out: SolveSuccess): Command[] {
    const cmds: Command[] = [];
    for (const s of this.sonars) cmds.push(...this.observeSonar(vns, out, s));
    for (const d of this.dhts) cmds.push(...this.observeDht(vns, out, d));
    return cmds;
  }

  private observeSonar(vns: bigint, out: SolveSuccess, s: Sonar): Command[] {
    const r = out.components[s.id];
    const t = r?.terminals;
    const powered = r?.state?.powered === true;
    const v = t && t.trig != null && t.gnd != null ? t.trig - t.gnd : null;
    const next = hcsr04TrigLevel(powered ? v : null, s.trig);
    const prev = s.trig;
    s.trig = next;
    if (prev === 0 && next === 1) {
      s.riseNs = vns;
      return [];
    }
    if (!(prev === 1 && next === 0) || s.riseNs === null) return [];
    const widthUs = Number(vns - s.riseNs) / 1000;
    s.riseNs = null;
    if (!powered || vns < s.busyUntil) return [];
    const distance = this.engine.liveQuantity(s.id, 'distance') ?? 0;
    const air = this.engine.liveQuantity(s.id, 'airTemperature') ?? 20;
    const echo = hcsr04Echo(vns, widthUs, distance, air);
    if (!echo) return [];
    const cmds = this.respond(vns, s.id, 'echo', 'low', [
      { atNs: echo.riseNs, token: 'high' },
      { atNs: echo.fallNs, token: 'low' },
    ]);
    if (cmds) s.busyUntil = echo.fallNs;
    return cmds ?? [];
  }

  private observeDht(vns: bigint, out: SolveSuccess, d: Dht): Command[] {
    const r = out.components[d.id];
    const t = r?.terminals;
    const powered = r?.state?.powered === true;
    if (!powered) {
      d.poweredSince = null;
      d.lowSince = null;
      return [];
    }
    d.poweredSince ??= vns;
    if (vns < d.busyUntil) return []; // its own response is on the line
    const vdd = t!.vdd! - t!.gnd!;
    const v = t!.data != null ? t!.data - t!.gnd! : 0;
    const prev = d.line;
    d.line = v <= CMOS_LOW * vdd ? 0 : v >= CMOS_HIGH * vdd ? 1 : prev;
    if (prev === 1 && d.line === 0) d.lowSince = vns;
    if (!(prev === 0 && d.line === 1) || d.lowSince === null) return [];
    const lowNs = vns - d.lowSince;
    d.lowSince = null;
    if (lowNs < DHT22_START_MIN_NS) return [];
    if (vns - d.poweredSince < DHT22_POWER_UP_NS) return this.silent(vns, d.id, 'power_up');
    if (d.lastAnswer !== null && vns - d.lastAnswer < DHT22_PERIOD_NS)
      return this.silent(vns, d.id, 'collecting_period');
    const frame = dht22Frame(
      this.engine.liveQuantity(d.id, 'humidity') ?? 0,
      this.engine.liveQuantity(d.id, 'temperature') ?? 0,
    );
    if (!frame) return [];
    let at = vns + DHT22_TGO_NS;
    const steps: { atNs: bigint; token: string }[] = [];
    for (const [level, us] of dht22Waveform(frame)) {
      steps.push({ atNs: at, token: level ? 'released' : 'low' });
      at += BigInt(us) * 1000n;
    }
    steps.push({ atNs: at, token: 'released' });
    const cmds = this.respond(vns, d.id, 'data', 'released', steps);
    if (cmds) {
      d.lastAnswer = vns;
      d.busyUntil = at;
    }
    return cmds ?? [];
  }

  private silent(vns: bigint, component: string, reason: string): Command[] {
    this.note(vns, {
      code: 'sensor_no_response',
      severity: 'warning',
      detail: { component, reason },
    });
    return [];
  }

  /**
   * Schedule a response: the sensor's output takes each token at each time. Levels per attached
   * pad come from solving the circuit in each output state. Null (and a diagnostic) when the
   * schedule limits or the per-second budget would be exceeded: the response is then not given at
   * all, never in part.
   */
  private respond(
    vns: bigint,
    component: string,
    key: string,
    idle: string,
    steps: { atNs: bigint; token: string }[],
  ): Command[] | null {
    // Pad voltages per output state (the engine's state is restored afterwards).
    const volts = new Map<string, Map<number, number>>();
    for (const token of new Set([idle, ...steps.map((s) => s.token)])) {
      this.engine.setPartRuntime(component, key, token);
      const o = this.engine.solve();
      if (!o.ok) {
        this.engine.setPartRuntime(component, key, idle);
        this.engine.solve();
        return this.refuse(vns, component, 'electrical_error');
      }
      volts.set(token, new Map((o.pins ?? []).map((p) => [p.gpio, p.voltage])));
    }
    this.engine.setPartRuntime(component, key, idle);
    this.engine.solve();

    const events: PartEvent[] = [];
    const cmds: Command[] = [];
    const level = new Map(this.pads.map((p) => [p, this.inputLevels.get(p) ?? 0] as const));
    for (const s of steps) {
      const levels = new Map<number, DigitalLevel>();
      for (const pad of this.pads) {
        const v = volts.get(s.token)!.get(pad);
        if (v === undefined) continue;
        if (v > V_IL_V && v < V_IH_V && this.watched(pad)) {
          this.undefinedLevel ??= { gpio: pad, voltage: v, component };
          return null;
        }
        const next = interpretDigitalInput(v, level.get(pad)!);
        if (next === level.get(pad)) continue;
        level.set(pad, next);
        levels.set(pad, next);
        cmds.push({ type: 'J', vns: s.atNs, pad, level: next });
      }
      events.push({ atNs: s.atNs, component, key, token: s.token, levels });
    }
    // Limits first, all or nothing: the queue mirror and the per-simulated-second budget.
    const window = vns / 1_000_000_000n;
    if (window !== this.budgetWindow) {
      this.budgetWindow = window;
      this.budgetUsed = 0;
    }
    if (this.budgetUsed + cmds.length > J_BUDGET_PER_SIM_S)
      return this.refuse(vns, component, 'budget');
    const trial: { vns: bigint; pad: number }[] = [];
    for (const c of cmds) {
      const j = c as Extract<Command, { type: 'J' }>;
      if (
        this.schedule.size + trial.length >= 512 ||
        this.schedule.problem(j.vns, j.pad) ||
        trial.some(
          (t) => t.pad === j.pad && (t.vns > j.vns ? t.vns - j.vns : j.vns - t.vns) < 1000n,
        )
      )
        return this.refuse(vns, component, 'queue');
      trial.push({ vns: j.vns, pad: j.pad });
    }
    this.budgetUsed += cmds.length;
    this.events.push(...events);
    this.events.sort((a, b) => (a.atNs < b.atNs ? -1 : a.atNs > b.atNs ? 1 : 0));
    return cmds;
  }

  private refuse(vns: bigint, component: string, reason: string): null {
    this.note(vns, {
      code: reason === 'electrical_error' ? 'sensor_no_response' : 'input_schedule_full',
      severity: 'warning',
      detail: { component, reason },
    });
    return null;
  }
}

/** DHT22 constants re-exported for the part notes and tests. */
export const DHT22_SUPPLY_MIN_V = DHT22_DC.minSupplyV;

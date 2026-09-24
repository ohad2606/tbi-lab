/**
 * A classic-ESP32 session closed through the production electrical engine, for any circuit.
 *
 * The caller builds a `Circuit` and says which ESP32 pads are attached to which `GpioPin`
 * devices. The loop is event-driven, never quantised to the command tick:
 *   - a pad event (G) sets the pin's mode and re-solves at that exact simulation time;
 *   - every attached input pad whose interpreted level changed is injected in the same reply,
 *     so the guest sees the electrical response before its next instruction;
 *   - scheduled circuit commands (e.g. a supply setpoint) apply only at command ticks (ADR-007).
 * Pads the circuit does not attach (flash, console, unused) are recorded but never answered with
 * electrical input: on the real board they are not available to the circuit.
 */
import { createHash } from 'node:crypto';
import {
  interpretDigitalInput,
  type Circuit,
  type DigitalLevel,
  type GpioPin,
} from '@tbi-lab/engine';
import { createSessionOverlay } from './artifacts.js';
import type { Command } from './protocol.js';
import { CommandSchedule, type Scheduled } from './schedule.js';
import { runSession, type PadEvent, type SessionOptions, type SessionResult } from './session.js';

export interface AttachedPad {
  pad: number;
  pin: GpioPin;
  /** The circuit node the pin drives / senses. */
  node: string;
  /** Interpret this pad's node voltage and inject it into the guest (an input-capable pad). */
  input: boolean;
}

export interface Solve {
  vns: bigint;
  cause: string;
  voltages: ReadonlyMap<string, number>;
  currents: ReadonlyMap<string, number>;
}

export interface CircuitSessionOptions {
  qemu: string;
  artifact: string;
  artifactSha256: string;
  circuit: Circuit;
  pads: AttachedPad[];
  endNs: bigint;
  tickUs?: number;
  /** Circuit changes, applied at the first command tick at or after `atNs`. */
  commands?: Scheduled<{ label: string; apply: () => void }>[];
  /** Extra per-tick host commands (e.g. serial input), before the circuit commands. */
  onTick?(vns: bigint): Command[];
  session?: Partial<
    Pick<
      SessionOptions,
      | 'stressMainLoop'
      | 'wallTimeoutMs'
      | 'stallTimeoutMs'
      | 'serialLimitBytes'
      | 'fault'
      | 'onSpawn'
    >
  >;
}

export interface CircuitSessionRecord {
  session: SessionResult;
  timeline: string[];
  timelineSha256: string;
  solves: Solve[];
  padEvents: PadEvent[];
  /** Pad events on pads the circuit does not attach. */
  unattachedPadEvents: PadEvent[];
  injections: { vns: bigint; pad: number; level: DigitalLevel }[];
  serialTimeline: { vns: bigint; bytes: Buffer }[];
  serialTimedSha256: string;
  guestWroteFlash: boolean;
  prepareMs: number;
}

const f = (x: number): string => x.toPrecision(17);
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

export async function runCircuitSession(
  opts: CircuitSessionOptions,
): Promise<CircuitSessionRecord> {
  const byPad = new Map(opts.pads.map((p) => [p.pad, p]));
  const inputs = opts.pads.filter((p) => p.input);
  const level = new Map<number, DigitalLevel>();
  const schedule = new CommandSchedule(opts.commands ?? []);
  const timeline: string[] = [];
  const solves: Solve[] = [];
  const padEvents: PadEvent[] = [];
  const unattachedPadEvents: PadEvent[] = [];
  const injections: CircuitSessionRecord['injections'] = [];
  const serialTimeline: CircuitSessionRecord['serialTimeline'] = [];

  const solveAt = (vns: bigint, cause: string): Command[] => {
    if (opts.pads.length === 0) return []; // nothing attached: no electrical circuit to solve
    const r = opts.circuit.solve();
    solves.push({ vns, cause, voltages: r.nodeVoltages, currents: r.deviceCurrents });
    const nodes = [...r.nodeVoltages.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    timeline.push(`V ${vns} ${cause} ${nodes.map(([n, v]) => `${n}=${f(v)}`).join(' ')}`);
    const out: Command[] = [];
    for (const p of inputs) {
      const prev = level.get(p.pad);
      const next = interpretDigitalInput(r.nodeVoltages.get(p.node)!, prev ?? 0);
      if (prev === next) continue;
      level.set(p.pad, next);
      injections.push({ vns, pad: p.pad, level: next });
      timeline.push(`I ${vns} gpio${p.pad}<=${next}`);
      out.push({ type: 'I', pad: p.pad, level: next });
    }
    return out;
  };

  const overlay = createSessionOverlay(opts.artifact, opts.artifactSha256);
  try {
    const session = await runSession(
      {
        qemu: opts.qemu,
        flash: overlay.flash,
        dir: overlay.dir,
        tickUs: opts.tickUs ?? 1000,
        ...opts.session,
      },
      {
        hello: () => solveAt(0n, 'initial'),
        pad: (e) => {
          timeline.push(`G ${e.vns} gpio${e.pad} drive=${e.drive} level=${e.level}`);
          const p = byPad.get(e.pad);
          if (!p) {
            unattachedPadEvents.push(e);
            return [];
          }
          padEvents.push(e);
          p.pin.setMode(e.drive ? (e.level ? 'output-high' : 'output-low') : 'input');
          return solveAt(e.vns, `gpio${e.pad}`);
        },
        tick: (vns) => {
          if (vns >= opts.endNs) return [{ type: 'Q' }];
          const extra = opts.onTick?.(vns) ?? [];
          const due = schedule.due(vns);
          if (!due.length) return extra;
          for (const d of due) {
            d.command.apply();
            timeline.push(`K ${vns} ${d.command.label} scheduled=${d.atNs}`);
          }
          return [...extra, ...solveAt(vns, 'command')];
        },
        serial: (vns, bytes) => {
          serialTimeline.push({ vns, bytes });
        },
      },
    );
    return {
      session,
      timeline,
      timelineSha256: sha(timeline.join('\n')),
      solves,
      padEvents,
      unattachedPadEvents,
      injections,
      serialTimeline,
      serialTimedSha256: sha(
        serialTimeline.map((s) => `${s.vns} ${s.bytes.toString('hex')}`).join('\n'),
      ),
      guestWroteFlash: overlay.guestWrote(),
      prepareMs: overlay.prepareMs,
    };
  } finally {
    overlay.discard();
  }
}

/** Serial output as text lines, each stamped with the simulation time its last byte left UART0. */
export function serialLines(
  serial: { vns: bigint; bytes: Buffer }[],
): { vns: bigint; text: string }[] {
  const out: { vns: bigint; text: string }[] = [];
  let cur = '';
  for (const s of serial) {
    for (const ch of s.bytes.toString('latin1')) {
      if (ch === '\n') {
        out.push({ vns: s.vns, text: cur.replace(/\r$/, '') });
        cur = '';
      } else cur += ch;
    }
  }
  return out;
}

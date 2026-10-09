/**
 * Runtime release-gate workload R-MCU-1 (ADR-007), on the R1 maintained-baseline runtime.
 *
 * The Sprint 1 reference scenario, unchanged in substance: real classic-ESP32 Arduino firmware
 * (TbiGpioProof: GPIO2/GPIO18 outputs, GPIO5 input) closed through the production electrical engine:
 *
 *   GPIO2 -> 220 ohm -> red LED -> GND
 *   GPIO2 -> 10 k -> GPIO5 <- 10 k <- VEXT (lab PSU, 100 mA limit)
 *
 * VEXT follows an ordered command sequence scheduled in SIMULATION time, so GPIO5 lands LOW, HIGH,
 * or inside the undefined band where the input holds its previous level. The fingerprint covers
 * every observable fact in order: pad events, every solve (node voltages, LED current, PSU mode at
 * full precision), every injected input, every command application, and the serial output with its
 * simulation timestamps.
 */
import { createHash } from 'node:crypto';
import {
  Circuit,
  Diode,
  GpioPin,
  LabPsu,
  LED_TLHR5400,
  Resistor,
  interpretDigitalInput,
  type DigitalLevel,
} from '@tbi-lab/engine';
import { createSessionOverlay } from './artifacts.js';
import type { Command } from './protocol.js';
import { CommandSchedule } from './schedule.js';
import { runSession, type SessionResult } from './session.js';

export const STIMULUS = [
  { atNs: 13_000_000_000n, setpointV: 3.3 },
  { atNs: 13_600_000_000n, setpointV: 0 },
  { atNs: 14_200_000_000n, setpointV: 3.3 },
  { atNs: 14_900_000_000n, setpointV: 0 },
];

export interface ClosedLoopOptions {
  qemu: string;
  artifact: string;
  artifactSha256: string;
  endNs: bigint;
  tickUs: number;
  stressMainLoop?: boolean;
  /** Apply the scheduled VEXT commands (the boot-window configuration has none before 3 s). */
  commands?: boolean;
  /** Observation only (measurements): never changes what the session does. */
  onSpawn?(pid: number): void;
  onTick?(vns: bigint): void;
  /**
   * Sprint 12 (T-DET-3): scheduled input edges on a pad the firmware never reads, sent in the
   * handshake reply (needs sched-input). They must leave every fingerprint unchanged.
   */
  noise?: { pad: number; edges: number; periodNs: bigint };
  /** Filled with the runtime's bridge capabilities at the handshake. */
  capsOut?: string[];
  /** Sprint 12 (D-10): pacing cap (session.ts); must not change any fingerprint. */
  pace?: { rate: number };
}

export interface ClosedLoopRecord {
  session: SessionResult;
  timeline: string[];
  serialTimeline: string[];
  timelineSha256: string;
  /** sha256 of the serial bytes alone (comparable to Sprint 1). */
  serialSha256: string;
  /** sha256 of the serial frames with their simulation timestamps. */
  serialTimedSha256: string;
  counts: { padEvents: number; solves: number; injections: number; commands: number };
  guestWroteFlash: boolean;
  prepareMs: number;
}

const f = (x: number): string => x.toPrecision(17);
const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

export async function runClosedLoop(opts: ClosedLoopOptions): Promise<ClosedLoopRecord> {
  const c = new Circuit();
  const io2 = c.add(new GpioPin('IO2', 'io2', 'input'));
  c.add(new Resistor('R1', 'io2', 'led_a', 220));
  c.add(new Diode('D1', 'led_a', '0', LED_TLHR5400));
  c.add(new Resistor('R2', 'io2', 'io5', 10_000));
  c.add(new GpioPin('IO5', 'io5', 'input'));
  const vext = c.add(new LabPsu('VEXT', 'ext', '0', 0, 0.1));
  c.add(new Resistor('R3', 'ext', 'io5', 10_000));

  const schedule = new CommandSchedule(
    (opts.commands ?? true) ? STIMULUS.map((s) => ({ atNs: s.atNs, command: s.setpointV })) : [],
  );
  const timeline: string[] = [];
  const serialTimeline: string[] = [];
  const counts = { padEvents: 0, solves: 0, injections: 0, commands: 0 };
  let in5: DigitalLevel = 0;
  let injected = false;

  const solveAt = (vns: bigint, cause: string): Command[] => {
    const r = c.solve();
    counts.solves++;
    const v5 = r.nodeVoltages.get('io5')!;
    timeline.push(
      `V ${vns} ${cause} io2=${f(r.nodeVoltages.get('io2')!)} io5=${f(v5)} iLED=${f(r.deviceCurrents.get('D1')!)} vext=${f(vext.setpointV)} mode=${r.supplyModes.get('VEXT')}`,
    );
    const next = interpretDigitalInput(v5, in5);
    if (next === in5 && injected) return [];
    in5 = next;
    injected = true;
    counts.injections++;
    timeline.push(`I ${vns} gpio5<=${in5}`);
    return [{ type: 'I', pad: 5, level: in5 }];
  };

  const overlay = createSessionOverlay(opts.artifact, opts.artifactSha256);
  try {
    const session = await runSession(
      {
        qemu: opts.qemu,
        flash: overlay.flash,
        dir: overlay.dir,
        tickUs: opts.tickUs,
        ...(opts.stressMainLoop ? { stressMainLoop: true } : {}),
        ...(opts.onSpawn ? { onSpawn: opts.onSpawn } : {}),
        ...(opts.pace ? { pace: opts.pace } : {}),
      },
      {
        hello: (_tick, caps) => {
          opts.capsOut?.push(...caps);
          const cmds = solveAt(0n, 'initial');
          const n = opts.noise;
          if (n)
            for (let i = 1; i <= n.edges; i++)
              cmds.push({
                type: 'J',
                vns: BigInt(i) * n.periodNs,
                pad: n.pad,
                level: (i & 1) as 0 | 1,
              });
          return cmds;
        },
        pad: (e) => {
          counts.padEvents++;
          timeline.push(`G ${e.vns} gpio${e.pad} drive=${e.drive} level=${e.level}`);
          if (e.pad !== 2) return [];
          io2.setMode(e.drive ? (e.level ? 'output-high' : 'output-low') : 'input');
          return solveAt(e.vns, 'gpio2');
        },
        tick: (vns) => {
          opts.onTick?.(vns);
          if (vns >= opts.endNs) return [{ type: 'Q' }];
          const due = schedule.due(vns);
          if (!due.length) return [];
          for (const d of due) {
            vext.setpointV = d.command;
            counts.commands++;
            timeline.push(`K ${vns} VEXT.setpoint=${d.command} scheduled=${d.atNs}`);
          }
          return solveAt(vns, 'command');
        },
        serial: (vns, bytes) => serialTimeline.push(`${vns} ${bytes.toString('hex')}`),
      },
    );
    return {
      session,
      timeline,
      serialTimeline,
      timelineSha256: sha(timeline.join('\n')),
      serialSha256: sha(session.serial),
      serialTimedSha256: sha(serialTimeline.join('\n')),
      counts,
      guestWroteFlash: overlay.guestWrote(),
      prepareMs: overlay.prepareMs,
    };
  } finally {
    overlay.discard();
  }
}

/**
 * Sprint 1 closure spike: deterministic closed MCU <-> electrical loop.
 *
 * Real classic-ESP32 firmware (Sprint 0 Arduino GPIO proof) on the Gate C runtime under
 * `-icount shift=3,sleep=off`, with the tbi-gpio-bridge `syncport` mode: every GPIO event and
 * every virtual-time tick is a SYNCHRONOUS exchange performed by QEMU while holding its big lock,
 * so the host's response is applied at a defined point in the guest instruction stream and host
 * scheduling cannot move it.
 *
 * The host side is the REAL Gate A electrical engine and Gate C pin model. External stimulus is an
 * ordered command sequence scheduled in SIMULATION time, applied at the first tick at or after its
 * scheduled time.
 *
 * Not product code.
 */

import { connect, createServer, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Circuit } from '../../gate-a-electrical/src/circuit.js';
import { Diode, LabPsu, Resistor } from '../../gate-a-electrical/src/devices.js';
import { LED_TLHR5400 } from '../../gate-a-electrical/src/models.js';
import { GpioPin, interpretDigitalInput, type DigitalLevel } from '../../gate-c-bridge/src/pinModel.js';

export const QEMU = process.env.TBI_QEMU ?? '/home/ubuntu/tbi-tools/src/a159-qemu/build/qemu-system-xtensa';
export const FLASH = process.env.TBI_ARDUINO_FLASH ?? '/home/ubuntu/tbi-tools/fw/arduino-gpio-proof-4mb.bin';
/**
 * Pristine artifact hash (Sprint 0 Arduino GPIO proof, DIO). The guest can write to flash (e.g. a
 * panic writes the coredump partition), so the artifact is never attached directly: every run boots
 * from a fresh scratch copy of a hash-verified image. Otherwise "identical initial state" is false.
 */
export const FLASH_SHA256 =
  process.env.TBI_ARDUINO_FLASH_SHA256 ?? 'd069fffc27f7d7246ff94120ed4b0d3bddb0b85228dee3d9fbb20ba1a20cdd44';
const RESERVED = (1 << 4) | (1 << 16) | (1 << 27);

/** Ordered external command sequence, in SIMULATION time (ns). */
export const STIMULUS: Array<{ atNs: bigint; target: 'VEXT'; setpointV: number }> = [
  { atNs: 13_000_000_000n, target: 'VEXT', setpointV: 3.3 },
  { atNs: 13_600_000_000n, target: 'VEXT', setpointV: 0 },
  { atNs: 14_200_000_000n, target: 'VEXT', setpointV: 3.3 },
  { atNs: 14_900_000_000n, target: 'VEXT', setpointV: 0 },
];

export interface RunOptions {
  icount: boolean;
  endNs: bigint;
  pollUs: number;
  timeoutMs?: number;
  /** Diagnostic stress: keep QEMU's main loop busy with a monitor client querying every 1 ms. */
  stressMainLoop?: boolean;
}

export interface RunRecord {
  /** Every externally observable fact, in order: events, solves, injections, commands. */
  timeline: string[];
  serial: string;
  timelineSha256: string;
  serialSha256: string;
  /** Diagnostics only (not part of the determinism contract): per-tick vCPU PCs. */
  ticks: string[];
  wallMs: number;
  counts: { gpioEvents: number; solves: number; injections: number; commands: number; ticks: number };
  /** sha256 of the verified source artifact the run booted from (a scratch copy of it). */
  flashSha256: string;
  /** Whether the guest modified its scratch flash during the run (diagnostic). */
  flashWritten: boolean;
}

function buildCircuit() {
  const c = new Circuit();
  const io2 = c.add(new GpioPin('IO2', 'io2', 'input'));
  c.add(new Resistor('R1', 'io2', 'led_a', 220));
  c.add(new Diode('D1', 'led_a', '0', LED_TLHR5400));
  c.add(new Resistor('R2', 'io2', 'io5', 10_000));
  const io5 = c.add(new GpioPin('IO5', 'io5', 'input'));
  const vext = c.add(new LabPsu('VEXT', 'ext', '0', 0, 0.1));
  c.add(new Resistor('R3', 'ext', 'io5', 10_000));
  return { c, io2, io5, vext };
}

/** Full-precision, platform-independent number formatting for the fingerprint. */
const f = (x: number): string => x.toPrecision(17);

export async function runClosedLoop(opts: RunOptions): Promise<RunRecord> {
  const { c, io2, vext } = buildCircuit();
  let in5: DigitalLevel = 0;
  let injectedInitial = false;
  let nextCmd = 0;
  const timeline: string[] = [];
  const ticks: string[] = [];
  const counts = { gpioEvents: 0, solves: 0, injections: 0, commands: 0, ticks: 0 };
  const flashBytes = readFileSync(FLASH);
  const flashSha256 = createHash('sha256').update(flashBytes).digest('hex');
  if (flashSha256 !== FLASH_SHA256) {
    throw new Error(`firmware artifact ${FLASH} has sha256 ${flashSha256}, expected ${FLASH_SHA256}`);
  }
  const scratch = mkdtempSync(join(tmpdir(), 'tbi-closed-loop-'));
  const flashCopy = join(scratch, 'flash.bin');
  copyFileSync(FLASH, flashCopy);
  const serialPath = join(scratch, 'serial.log');

  /** Solve at simulation time vns and return the input-pin commands to send. */
  const solveAt = (vns: string, cause: string): string[] => {
    const r = c.solve();
    counts.solves++;
    const vIo5 = r.nodeVoltages.get('io5')!;
    timeline.push(
      `S ${vns} ${cause} io2=${f(r.nodeVoltages.get('io2')!)} io5=${f(vIo5)} iLED=${f(r.deviceCurrents.get('D1')!)} vext=${f(vext.setpointV)} mode=${r.supplyModes.get('VEXT')}`,
    );
    const next = interpretDigitalInput(vIo5, in5);
    const out: string[] = [];
    if (next !== in5 || !injectedInitial) {
      in5 = next;
      injectedInitial = true;
      out.push(`I 5 ${in5}`);
    }
    return out;
  };

  const started = Date.now();
  return await new Promise<RunRecord>((resolve, reject) => {
    let finished = false;
    let qemu: ReturnType<typeof spawn> | null = null;
    const server = createServer((sock: Socket) => {
      sock.setNoDelay(true);
      let buf = '';
      sock.on('data', (chunk) => {
        buf += chunk.toString('latin1');
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (finished) continue;
          const p = line.split(' ');
          const replies: string[] = [];
          if (p[0] === 'O' || p[0] === 'D') {
            const [kind, pinS, valS, vns] = p as [string, string, string, string];
            counts.gpioEvents++;
            timeline.push(`${kind} ${vns} gpio${pinS}=${valS}`);
            if (pinS === '2') {
              if (kind === 'O') io2.setMode(valS === '1' ? 'output-high' : 'output-low');
              else if (valS === '0') io2.setMode('input');
              replies.push(...solveAt(vns, `gpio2.${kind}`));
            }
            if (BigInt(vns) >= opts.endNs) finish();
          } else if (p[0] === 'T') {
            const vns = p[1]!;
            counts.ticks++;
            ticks.push(line);
            const now = BigInt(vns);
            let changed = !injectedInitial;
            while (nextCmd < STIMULUS.length && STIMULUS[nextCmd]!.atNs <= now) {
              const cmd = STIMULUS[nextCmd++]!;
              vext.setpointV = cmd.setpointV;
              counts.commands++;
              timeline.push(`K ${vns} ${cmd.target}.setpoint=${cmd.setpointV} scheduled=${cmd.atNs}`);
              changed = true;
            }
            if (changed) replies.push(...solveAt(vns, 'tick'));
            if (now >= opts.endNs) finish();
          } else if (p[0] === 'A') {
            counts.injections++;
            timeline.push(`A ${p[3]} gpio${p[1]}<=${p[2]}`);
            continue; // acknowledgements need no reply
          } else {
            continue;
          }
          if (!finished) sock.write(replies.map((r) => r + '\n').join('') + 'C\n');
        }
      });
      sock.on('error', () => {});
    });

    function finish(): void {
      if (finished) return;
      finished = true;
      qemu?.kill('SIGKILL');
    }

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'string' || !addr) return reject(new Error('no address'));
      const args = [
        '-machine', 'esp32', '-display', 'none', '-monitor', 'none',
        '-drive', `file=${flashCopy},if=mtd,format=raw`,
        '-serial', `file:${serialPath}`,
        '-device', `tbi-gpio-bridge,syncport=${addr.port},poll-us=${opts.pollUs},ignore-mask=${RESERVED}`,
        ...(opts.icount ? ['-icount', 'shift=3,sleep=off'] : []),
      ];
      const qmpPort = addr.port + 1;
      if (opts.stressMainLoop) {
        args.push('-qmp', `tcp:127.0.0.1:${qmpPort},server=on,wait=off`);
      }
      qemu = spawn(QEMU, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      if (opts.stressMainLoop) {
        // Keep QEMU's main loop busy: a QMP client issuing query-status about every 1 ms.
        // query-status does not touch the guest.
        const attach = (): void => {
          const q = connect(qmpPort, '127.0.0.1');
          q.on('error', () => { if (!finished) setTimeout(attach, 50); });
          q.on('data', () => {});
          q.on('connect', () => {
            q.write('{"execute":"qmp_capabilities"}\n');
            const t = setInterval(() => { if (!q.destroyed && !finished) q.write('{"execute":"query-status"}\n'); }, 1);
            q.on('close', () => clearInterval(t));
          });
        };
        setTimeout(attach, 100);
      }
      let stderr = '';
      qemu.stderr?.on('data', (d) => (stderr += d.toString()));
      const timer = setTimeout(() => {
        finish();
      }, opts.timeoutMs ?? 240_000);
      qemu.on('exit', () => {
        clearTimeout(timer);
        server.close();
        finished = true;
        let serial = '';
        try {
          serial = readFileSync(serialPath, 'latin1');
        } catch {
          /* no serial */
        }
        const flashAfterSha256 = createHash('sha256').update(readFileSync(flashCopy)).digest('hex');
        rmSync(scratch, { recursive: true, force: true });
        const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
        resolve({
          timeline,
          serial,
          timelineSha256: sha(timeline.join('\n')),
          serialSha256: sha(serial),
          ticks,
          wallMs: Date.now() - started,
          counts,
          flashSha256,
          flashWritten: flashAfterSha256 !== flashSha256,
        });
        if (counts.gpioEvents === 0 && stderr) console.error(stderr.slice(-400));
      });
    });
  });
}

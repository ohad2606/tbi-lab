/**
 * Sprint 12 R3 probe runner: boots a firmware image on the scratch QEMU through the repo's
 * unchanged harness (synchronous bridge, 1 ms tick, icount shift=3,sleep=off, exactly the session
 * configuration), stops when the guest prints PROBE-END (or after a simulated-time limit), and
 * writes serial + outcome + the target/controller log path to JSON.
 *   vite-node run-probe.ts -- <qemu> <flash.bin> <out.json> <i2c log> [simMs]
 */
import { copyFileSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { runSession } from '/home/ubuntu/projects/tbi-lab-s11/runtime/harness/session.ts';

const [qemu, image, out, log, simMsArg] = process.argv.slice(2);
const simLimitNs = BigInt(Number(simMsArg ?? 20000)) * 1_000_000n;
const dir = mkdtempSync(join('/home/ubuntu/tbi-s12-probe/run', 's-'));
chmodSync(dir, 0o700);
const flash = join(dir, 'flash.bin');
copyFileSync(image, flash);
let serial = '';
let endVns: bigint | null = null;
let quit = false;
const pads: string[] = [];
const r = await runSession(
  {
    qemu,
    flash,
    dir,
    tickUs: 1000,
    wallTimeoutMs: 600_000,
    env: { ...process.env, TBI_PROBE_I2C_LOG: log },
  },
  {
    serial(vns, bytes) {
      serial += bytes.toString('latin1');
      if (endVns === null && serial.includes('PROBE-END')) endVns = vns;
    },
    pad(e) {
      pads.push(`${e.vns} ${e.pad} d${e.drive} l${e.level}`);
      return [];
    },
    tick(vns) {
      if (quit) return [];
      if (endVns !== null || vns >= simLimitNs) {
        quit = true;
        return [{ type: 'Q' }];
      }
      return [];
    },
  },
);
rmSync(dir, { recursive: true, force: true });
writeFileSync(
  out,
  JSON.stringify(
    { outcome: r.outcome, exitCode: r.exitCode, endVns: endVns?.toString() ?? null, lastVns: r.lastVns.toString(), wallMs: Math.round(r.wallMs), frames: r.frames, pads, diagnostics: r.diagnostics, serial },
    null,
    2,
  ),
);
console.log(r.outcome, 'endVns', endVns?.toString(), 'wallMs', Math.round(r.wallMs));

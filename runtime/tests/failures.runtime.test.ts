/**
 * R1.13: failure modes. Every failure ends the session with an explicit, classified outcome; nothing
 * restarts or retries silently; the immutable artifact is untouched; the evidence (diagnostics,
 * serial so far, exit status) is preserved in the result. Full-chip reset is unsupported.
 */
import { Circuit, GpioPin } from '@tbi-lab/engine';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createSessionOverlay, sha256File } from '../harness/artifacts.js';
import {
  runCircuitSession,
  serialLines,
  type CircuitSessionOptions,
} from '../harness/circuitSession.js';
import { QEMU, artifact, assertProvisioned, recordEvidence } from '../harness/env.js';
import { CommandOrderError, CommandSchedule } from '../harness/schedule.js';
import { runSession } from '../harness/session.js';

const FAKE_QEMU = fileURLToPath(new URL('./fixtures/fake-qemu.mjs', import.meta.url));
const outcomes: Record<string, unknown> = {};

function gpioProof(extra: Partial<CircuitSessionOptions> = {}) {
  const fw = artifact('TbiGpioProof');
  const c = new Circuit();
  const pin = c.add(new GpioPin('IO2', 'io2', 'input'));
  return runCircuitSession({
    qemu: QEMU,
    artifact: fw.path,
    artifactSha256: fw.sha256,
    circuit: c,
    pads: [{ pad: 2, pin, node: 'io2', input: false }],
    endNs: 3_000_000_000n,
    ...extra,
  });
}

function note(
  name: string,
  r: {
    session: {
      outcome: string;
      exitCode: number | null;
      signal: string | null;
      error?: string;
      diagnostics: string;
      frames: object;
    };
  },
) {
  outcomes[name] = {
    outcome: r.session.outcome,
    exitCode: r.session.exitCode,
    signal: r.session.signal,
    error: r.session.error,
    diagnostics: r.session.diagnostics.trim().split('\n').slice(-2),
    frames: r.session.frames,
  };
}

describe('R1.13 failure modes fail closed', () => {
  assertProvisioned();

  it('invalid firmware (erased flash): the ROM rejects it, simulation stops advancing, the session ends as stalled', async () => {
    const img = Buffer.alloc(4 << 20, 0xff);
    const path = join(tmpdir(), `tbi-invalid-fw-${process.pid}.bin`);
    writeFileSync(path, img, { mode: 0o444 });
    const r = await runCircuitSession({
      qemu: QEMU,
      artifact: path,
      artifactSha256: createHash('sha256').update(img).digest('hex'),
      circuit: new Circuit(),
      pads: [],
      endNs: 5_000_000_000n,
      session: { stallTimeoutMs: 5_000 },
    });
    note('invalid_firmware', r);
    expect(r.session.outcome).toBe('stalled');
    expect(r.session.frames.H).toBe(1);
    expect(r.session.serial.toString()).toMatch(/invalid header: 0xffffffff/);
    expect(r.session.lastVns).toBeLessThan(5_000_000_000n);
    expect(r.padEvents).toEqual([]);
  });

  it('artifact hash mismatch: refused before QEMU starts', () => {
    const a = artifact('TbiGpioProof');
    expect(() =>
      createSessionOverlay(
        a.path,
        a.sha256.replace(/^./, (ch) => (ch === '0' ? '1' : '0')),
      ),
    ).toThrow(/expected/);
  });

  it('QEMU crash (SIGSEGV): crashed, not restarted', async () => {
    let pid = 0;
    let killed = false;
    const r = await gpioProof({
      session: { onSpawn: (p) => (pid = p) },
      onTick: (vns) => {
        if (!killed && vns >= 1_000_000_000n) {
          killed = true;
          process.kill(pid, 'SIGSEGV');
        }
        return [];
      },
    });
    note('qemu_crash', r);
    expect(r.session.outcome).toBe('crashed');
    expect(r.session.signal).toBe('SIGSEGV');
    expect(r.session.frames.H).toBe(1);
  });

  it('host bridge crash (connection dropped): QEMU terminates itself with exit 4', async () => {
    const r = await gpioProof({
      session: { fault: { afterFrames: 500, kind: 'drop_connection' } },
    });
    note('bridge_crash', r);
    expect(r.session.outcome).toBe('peer_lost');
    expect(r.session.exitCode).toBe(4);
    expect(r.session.diagnostics).toMatch(/host connection lost/);
  });

  it('malformed reply from the host: QEMU rejects it with exit 3', async () => {
    const r = await gpioProof({
      session: { fault: { afterFrames: 500, kind: 'malformed_reply' } },
    });
    note('malformed_reply', r);
    expect(r.session.outcome).toBe('protocol_error_runtime');
    expect(r.session.exitCode).toBe(3);
    expect(r.session.diagnostics).toMatch(/unexpected reply from host/);
  });

  it('invalid input command (pad 40 does not exist): QEMU rejects it with exit 3', async () => {
    const r = await gpioProof({ session: { fault: { afterFrames: 500, kind: 'invalid_pad' } } });
    note('invalid_pad', r);
    expect(r.session.outcome).toBe('protocol_error_runtime');
    expect(r.session.exitCode).toBe(3);
    expect(r.session.diagnostics).toMatch(/malformed input command/);
  });

  for (const mode of ['malformed_frame', 'time_backwards', 'bad_version', 'garbage']) {
    it(`malformed frame from the runtime (${mode}): the host rejects it and terminates the runtime`, async () => {
      process.env.TBI_FAKE_QEMU_MODE = mode;
      const dir = createSessionOverlay(
        artifact('TbiGpioProof').path,
        artifact('TbiGpioProof').sha256,
      );
      try {
        const r = await runSession(
          { qemu: FAKE_QEMU, flash: dir.flash, dir: dir.dir, wallTimeoutMs: 10_000 },
          { hello: () => [], tick: () => [], pad: () => [] },
        );
        note(`frame_${mode}`, { session: r });
        expect(r.outcome).toBe('protocol_error_host');
        expect(r.error).toBeTruthy();
      } finally {
        dir.discard();
      }
    });
  }

  it('timeout (the host stops answering): the wall-clock limit terminates the session', async () => {
    const r = await gpioProof({
      session: { fault: { afterFrames: 200, kind: 'stop_replying' }, wallTimeoutMs: 5_000 },
    });
    note('timeout', r);
    expect(r.session.outcome).toBe('timeout');
  });

  it('host command ordering error: fails closed, never reordered or applied late', async () => {
    const schedule = new CommandSchedule<string>([{ atNs: 500_000_000n, command: 'x' }]);
    const r = await gpioProof({
      onTick: (vns) => {
        schedule.due(vns);
        if (vns === 1_000_000_000n) schedule.add({ atNs: 900_000_000n, command: 'late' }); // in the past
        return [];
      },
    });
    note('command_order', r);
    expect(r.session.outcome).toBe('host_error');
    expect(r.session.error).toMatch(/in the past/);
    expect(
      () =>
        new CommandSchedule([
          { atNs: 2n, command: 0 },
          { atNs: 1n, command: 0 },
        ]),
    ).toThrow(CommandOrderError);
  });

  it('guest-requested reset (esp_restart): unsupported, the session ends; no silent reboot', async () => {
    const fw = artifact('TbiRestart');
    const c = new Circuit();
    const pin = c.add(new GpioPin('IO2', 'io2', 'input'));
    const r = await runCircuitSession({
      qemu: QEMU,
      artifact: fw.path,
      artifactSha256: fw.sha256,
      circuit: c,
      pads: [{ pad: 2, pin, node: 'io2', input: false }],
      endNs: 5_000_000_000n,
    });
    note('guest_reset', r);
    const text = serialLines(r.serialTimeline).map((l) => l.text);
    expect(r.session.outcome).toBe('guest_exit');
    expect(text).toContain('TBI-RESTART-REQUEST');
    expect(text.filter((t) => t.startsWith('rst:'))).toHaveLength(1); // booted exactly once
    expect(r.session.frames.H).toBe(1);
    expect(r.session.lastVns).toBeLessThan(5_000_000_000n);
  });

  it('start failures are classified: missing runtime binary, unreadable flash', async () => {
    const a = artifact('TbiGpioProof');
    const o = createSessionOverlay(a.path, a.sha256);
    try {
      const missing = await runSession(
        { qemu: '/nonexistent/qemu-system-xtensa', flash: o.flash, dir: o.dir },
        {},
      );
      expect(missing.outcome).toBe('start_failed');
      const badFlash = await runSession({ qemu: QEMU, flash: `${o.flash}.absent`, dir: o.dir }, {});
      expect(badFlash.outcome).toBe('start_failed');
      expect(badFlash.diagnostics).toMatch(/absent/);
      outcomes['start_missing_binary'] = { outcome: missing.outcome, error: missing.error };
      outcomes['start_bad_flash'] = {
        outcome: badFlash.outcome,
        exitCode: badFlash.exitCode,
        diagnostics: badFlash.diagnostics.trim(),
      };
    } finally {
      o.discard();
    }
  });

  it('artifacts survive every failure unchanged', () => {
    for (const n of ['TbiGpioProof', 'TbiRestart'])
      expect(sha256File(artifact(n).path)).toBe(artifact(n).sha256);
    recordEvidence('failures', outcomes);
  });
});

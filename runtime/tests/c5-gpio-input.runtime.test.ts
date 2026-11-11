/**
 * The capacity and recovery harnesses' gpio workload (TbiGpioProof, c5-circuits.ts) on the REAL runtime.
 *
 * Alpha W1 retry (2026-11-11): every gpio session of the C-5 mix ended `electrical_error`
 * (`gpio_input_undefined`, ~1.7 s simulated) because the harness left GPIO5, which the firmware reads,
 * unconnected; Runtime v5 (Sprint 25) correctly refuses such a read. This reproduces that with the
 * earlier circuit, and shows the corrected circuit (10 k pull-up to 3.3 V on GPIO5) runs well past the
 * first read with GPIO5 read HIGH and no undefined input, as the harness' sessions must.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { artifact, assertProvisioned, recordEvidence, runtimeInfo } from '../harness/env.js';
import { TEST_TICKET_KEY, principalFor, ticketFor } from '../identity/test-gate.js';
import { signTicket } from '../identity/ticket.js';
import type { HostSession } from '../host/session.js';
import { serialText, waitEvent } from '../host/tests/support.js';
import { open } from '../host/tests/r1-support.js';
import {
  gpioProofCircuit,
  gpioProofReferenceCircuit,
  legacyGpioProofCircuit,
} from './c5-circuits.js';
import { realHost } from './r2-support.js';
import { stopped } from './r1-support.js';
import { runtimeCaps } from './s24-support.js';

const host = realHost();
afterAll(() => host.shutdown());
/** Simulated time the corrected session must run: the old circuit failed at ~1.7 s; four loop() reads. */
const RUN_NS = 6_000_000_000n;
const undefinedDiagnostics = (s: HostSession) =>
  s.log.since(0).filter((e) => e.type === 'diagnostic' && e.code === 'gpio_input_undefined');

describe.skipIf(!runtimeCaps().includes('input-read'))(
  'C-5 gpio workload: GPIO5 has a defined level',
  () => {
    it('reproduction: the earlier circuit (GPIO5 unconnected) ends gpio_input_undefined on gpio5', async () => {
      assertProvisioned();
      const a = artifact('TbiGpioProof');
      const s = open(host, {
        ...legacyGpioProofCircuit().request(a.sha256),
        ticket: ticketFor(a.sha256),
      });
      expect(s.state, JSON.stringify(s.status().detail)).toBe('ready');
      expect(s.run()).toEqual({ ok: true });
      await waitEvent(s, (e) => e.type === 'state' && e.state === 'failed', 120_000);
      const st = s.status();
      expect(st).toMatchObject({
        state: 'failed',
        reason: 'electrical_error',
        detail: { code: 'gpio_input_undefined', param: 'gpio5' },
      });
      recordEvidence('c5-gpio-input-legacy', { runtimeId: runtimeInfo().runtimeId, status: st });
    }, 180_000);

    it('corrected circuit: runs 6 s simulated, reads GPIO5 HIGH, no undefined input', async () => {
      assertProvisioned();
      const a = artifact('TbiGpioProof');
      const s = open(host, {
        ...gpioProofCircuit().request(a.sha256),
        ticket: ticketFor(a.sha256),
      });
      expect(s.state, JSON.stringify(s.status().detail)).toBe('ready');
      expect(s.run()).toEqual({ ok: true });
      await waitEvent(
        s,
        (e) =>
          (e.type === 'state' && (e.state === 'failed' || e.state === 'ended')) ||
          (e.simNs !== null && BigInt(e.simNs) >= RUN_NS),
        180_000,
      );
      const st = s.status();
      expect(st.state, JSON.stringify(st)).toBe('running');
      expect(undefinedDiagnostics(s)).toEqual([]);
      const serial = serialText(s);
      const reads = serial.match(/^IN=\d\r?$/gm) ?? [];
      expect(reads.length, serial).toBeGreaterThanOrEqual(4);
      expect(
        reads.every((l) => l.startsWith('IN=1')),
        serial,
      ).toBe(true);
      await stopped(s);
      recordEvidence('c5-gpio-input-fixed', {
        runtimeId: runtimeInfo().runtimeId,
        reads: reads.length,
        allHigh: true,
      });
    }, 240_000);

    // C5b leases TbiGpioProof as the R1 reference image: the build service issues no input-read analysis for it (features
    // null), so the host watches every user pin. The ticket here is exactly that: no features.
    const unanalysed = (sha: string) =>
      signTicket(TEST_TICKET_KEY, {
        v: 1,
        principal: principalFor(),
        sha256: sha,
        features: null,
        exp: Date.now() + 600_000,
      });

    it('reference image (no analysis): GPIO5 alone held is not enough, an unwired pin is undefined', async () => {
      assertProvisioned();
      const a = artifact('TbiGpioProof');
      const s = open(host, {
        ...gpioProofCircuit().request(a.sha256),
        ticket: unanalysed(a.sha256),
      });
      expect(s.run()).toEqual({ ok: true });
      await waitEvent(s, (e) => e.type === 'state' && e.state === 'failed', 120_000);
      expect(s.status()).toMatchObject({
        state: 'failed',
        reason: 'electrical_error',
        detail: { code: 'gpio_input_undefined', detail: { watchAll: true } },
      });
      recordEvidence('c5-gpio-input-reference-pin5only', {
        runtimeId: runtimeInfo().runtimeId,
        status: s.status(),
      });
    }, 180_000);

    it('reference image (no analysis), C5b circuit: every watched pin held; runs 6 s, GPIO5 HIGH, no undefined input', async () => {
      assertProvisioned();
      const a = artifact('TbiGpioProof');
      const s = open(host, {
        ...gpioProofReferenceCircuit().request(a.sha256),
        ticket: unanalysed(a.sha256),
      });
      expect(s.state, JSON.stringify(s.status().detail)).toBe('ready');
      expect(s.run()).toEqual({ ok: true });
      await waitEvent(
        s,
        (e) =>
          (e.type === 'state' && (e.state === 'failed' || e.state === 'ended')) ||
          (e.simNs !== null && BigInt(e.simNs) >= RUN_NS),
        180_000,
      );
      const st = s.status();
      expect(st.state, JSON.stringify(st)).toBe('running');
      expect(undefinedDiagnostics(s)).toEqual([]);
      const reads = serialText(s).match(/^IN=\d\r?$/gm) ?? [];
      expect(reads.length).toBeGreaterThanOrEqual(4);
      expect(reads.every((l) => l.startsWith('IN=1'))).toBe(true);
      await stopped(s);
      recordEvidence('c5-gpio-input-reference-c5b', {
        runtimeId: runtimeInfo().runtimeId,
        reads: reads.length,
      });
    }, 240_000);
  },
);

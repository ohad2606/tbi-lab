/**
 * Sprint 11 (R1) release-gate extension (ADR-007: every new peripheral or bridge feature extends
 * the release gate): the Sprint 10 part models in Session Host sessions are deterministic. The two
 * curated R1 examples, exactly as the app sends them, with live part parameters scheduled at fixed
 * SIMULATION times (atSimNs), run three times each: one runtime event stream per workload, pinned.
 * Firmware: the pinned TbiBanks image; runtime 33e35e4ac5e798d7.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { artifact, assertProvisioned, recordEvidence, runtimeInfo } from '../harness/env.js';
import { ticketFor } from '../identity/test-gate.js';
import { PROTOCOL, type CreateSessionRequest } from '../host/protocol.js';
import type { HostSession } from '../host/session.js';
import { waitState } from '../host/tests/support.js';
import { open, realHost, runtimeEvents } from './r2-support.js';

const host = realHost();
const evidence: Record<string, unknown> = {};
afterAll(async () => {
  recordEvidence('r1-determinism', evidence);
  await host.shutdown();
});

const sha = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
const END = 3_000_000_000n;

/**
 * Pinned runtime event-stream fingerprints (sha256 prefixes of the events up to END), established
 * 2026-10-08 from three runs each that reproduced one result. A change to the runtime, the
 * firmware, the engine or these circuits is a new baseline, re-established the same way.
 */
const PINNED_R1: Record<string, string> = {
  motion: '88122085bf12750f',
  night: '1511138e44d4f5e4',
};
/**
 * Runtime v2 (Sprint 12, patches 0006-0008), established 2026-10-10 from 10 runs each that
 * reproduced one result. Against R1 exactly one event differs per workload: the 0.89 s GPIO window
 * also carries the input-only pads 34, 35, 36 and 39 once (drive 0, level 0): `pinMode(INPUT)`
 * routes the pad to signal 0 for a few instructions and its return to simple GPIO is published
 * (re-pin mechanism 2, SPRINT-12.md F.1). Every electrical outcome and timestamp is unchanged.
 */
const PINNED_V2: Record<string, string> = {
  motion: '5fdb6a1ad50a412a',
  night: '5596d749c3ce4f8c',
};
/** Runtime v2 is the one carrying patch 0007 (pad functions). */
function isRuntimeV2(): boolean {
  try {
    return runtimeInfo().patches.some((p) => p.file.startsWith('0007-'));
  } catch {
    return false; // not provisioned: assertProvisioned() reports it
  }
}
const PINNED = isRuntimeV2() ? PINNED_V2 : PINNED_R1;
const RUNS = Number(process.env.TBI_R1_DET_RUNS ?? 3);

function fixture(name: string): CreateSessionRequest {
  const fx = JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as {
    request: Omit<CreateSessionRequest, 'artifact' | 'ticket'>;
  };
  const fw = artifact('TbiBanks');
  return {
    ...fx.request,
    protocol: PROTOCOL,
    artifact: { sha256: fw.sha256 },
    ticket: ticketFor(fw.sha256),
  };
}

/** A session with live part parameters queued at fixed simulation times, run to END. */
async function workload(
  req: CreateSessionRequest,
  component: string,
  schedule: [bigint, Record<string, number | boolean>][],
): Promise<HostSession> {
  const s = open(host, req);
  expect(s.state).toBe('ready');
  let rev = req.circuit.projectRevision;
  schedule.forEach(([at, params], i) => {
    expect(
      s.submit({
        category: 'mirror',
        seq: i + 1,
        atSimNs: at.toString(),
        projectRevision: ++rev,
        component,
        control: { params },
      }),
    ).toMatchObject({ accepted: true });
  });
  expect(s.run()).toEqual({ ok: true });
  await expect
    .poll(() => BigInt(s.status().simNs) >= END, { timeout: 180_000, interval: 50 })
    .toBe(true);
  s.stop();
  await waitState(s, 'ended', 30_000);
  await s.done();
  return s;
}

describe('R1 determinism: the Sprint 10 parts in Session Host sessions', () => {
  for (const [key, file, component, schedule] of [
    [
      'motion',
      'r1-motion-relay-session.json',
      'U2',
      [
        [1_500_000_000n, { motion: true }],
        [2_200_000_000n, { motion: false }],
        [2_600_000_000n, { motion: true }],
      ],
    ],
    [
      'night',
      'r1-night-light-session.json',
      'LDR1',
      [
        [1_500_000_000n, { illuminance: 1 }],
        [2_000_000_000n, { illuminance: 20 }],
        [2_400_000_000n, { illuminance: 300 }],
      ],
    ],
  ] as const)
    it(`${file}: ${RUNS} sessions with scheduled live parameters reproduce one runtime event stream`, async () => {
      assertProvisioned();
      const hashes: string[] = [];
      const streams: ReturnType<typeof runtimeEvents>[] = [];
      for (let i = 0; i < RUNS; i++) {
        const s = await workload(fixture(file), component, schedule as never);
        const events = runtimeEvents(s, END);
        streams.push(events);
        hashes.push(sha(events));
      }
      evidence[key] = { hashes, events: streams[0]!.length };
      expect(new Set(hashes).size).toBe(1);
      // The workload exercised the parts: electrical outcomes and GPIO4 transitions both ways.
      const gpio4 = streams[0]!.flatMap((e) =>
        e.type === 'gpio'
          ? (e as unknown as { changes: { gpio: number; level: number }[] }).changes.filter(
              (c) => c.gpio === 4,
            )
          : [],
      );
      expect(gpio4.some((c) => c.level === 1)).toBe(true);
      expect(gpio4.some((c) => c.level === 0)).toBe(true);
      expect(hashes[0]).toBe(PINNED[key]);
    });
});

/**
 * Sprint 11 (R1) release-gate extension (ADR-007: every new peripheral or bridge feature extends
 * the release gate): the Sprint 10 part models in Session Host sessions are deterministic. The two
 * curated R1 examples, exactly as the app sends them, with live part parameters scheduled at fixed
 * SIMULATION times (atSimNs), run three times each: one runtime event stream per workload, pinned.
 * Firmware: the pinned TbiBanks image; runtime 33e35e4ac5e798d7.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { artifact, assertProvisioned, recordEvidence, runtimeInfo } from '../harness/env.js';
import { ticketFor } from '../identity/test-gate.js';
import { PROTOCOL, type CreateSessionRequest } from '../host/protocol.js';
import type { HostSession } from '../host/session.js';
import { waitState } from '../host/tests/support.js';
import { open, realHost, runtimeEvents } from './r2-support.js';
import { builtExample, runtimeCaps } from './s24-support.js';

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
 * Sprint 13 (10 runs, 2026-10-12): `motion` re-pinned from 5fdb6a1ad50a412a — H2 adds the field
 * `outsideModelRange: false` to the PIR sensor's (U2) outcome, the only difference (night has no
 * supply-limited part): docs/sprints/s13-evidence/ci/PIN-DRIFT-H2.md.
 */
const PINNED_V2: Record<string, string> = {
  motion: '738eafd0f967b9db',
  night: 'd0fe9405be94f7bb',
};
/*
 * Sprint 25 (3 runs each, 2026-10-31): re-pinned from 261f54efe0dd9a9c / 5596d749c3ce4f8c. The
 * engine adds `levelUndefined: 'floating'` to GPIO4's pin result in the first outcome (10 ms: the
 * firmware has not yet made it an output and nothing drives its net), the only difference: with
 * that field removed both streams hash to the previous pins exactly, on Runtime v4 and with the
 * Sprint 25 host (~/tbi-s25/evidence/drift).
 *
 * Runtime v5 (`input-read`): the examples' own sketch (built; it no longer reads the unconnected
 * GPIO35/36/39, which v5 refuses), so another firmware and another stream, pinned separately:
 * Runtime v5 39f2229a66d45e43, 2026-10-31, 3 runs each reproducing one stream (motion in two
 * separate invocations).
 */
const PINNED_V5: Record<string, string> = {
  motion: 'b2209dc279a78905',
  night: 'df93d751adbb9938',
};
const V5 = (() => {
  try {
    return runtimeCaps().includes('input-read');
  } catch {
    return false;
  }
})();
/** Runtime v2 is the one carrying patch 0007 (pad functions). */
function isRuntimeV2(): boolean {
  try {
    return runtimeInfo().patches.some((p) => p.file.startsWith('0007-'));
  } catch {
    return false; // not provisioned: assertProvisioned() reports it
  }
}
const PINNED = V5 ? PINNED_V5 : isRuntimeV2() ? PINNED_V2 : PINNED_R1;
const RUNS = Number(process.env.TBI_R1_DET_RUNS ?? 3);

/** Sprint 25: on Runtime v5 the examples' own sketch (r1-examples.runtime.test.ts says why). */
async function fixture(name: string): Promise<CreateSessionRequest> {
  const fx = JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as {
    request: Omit<CreateSessionRequest, 'artifact' | 'ticket'>;
  };
  if (V5) {
    const b = await builtExample(
      name === 'r1-motion-relay-session.json' ? 'esp32-motion-relay' : 'esp32-night-light',
    );
    return {
      ...fx.request,
      protocol: PROTOCOL,
      artifact: { sha256: b.sha256 },
      ticket: b.ticket(),
    };
  }
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
        const s = await workload(await fixture(file), component, schedule as never);
        const events = runtimeEvents(s, END);
        // Pin drift investigation: the event stream, to compare two runtimes' streams.
        if (process.env.TBI_DET_DUMP && i === 0)
          writeFileSync(
            join(process.env.TBI_DET_DUMP, `${key}.jsonl`),
            events.map((e) => JSON.stringify(e)).join('\n') + '\n',
          );
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

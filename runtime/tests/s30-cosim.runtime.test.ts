/**
 * Sprint 30 (M1/M2/M3 POC, real QEMU): genuine firmware drives logic, reads it back and reacts —
 * esp32-logic-feedback (Arduino) and mpy-logic-feedback (MicroPython) — with the host's timing
 * trace (HostConfig.timingTraceCapacity) as the evidence of WHEN each change happened.
 *
 * Clock contract under test (docs/sprints/SPRINT-30.md §M3): QEMU's virtual clock (icount) is the
 * only clock; a guest pad write blocks the guest until the host has solved the circuit and sent
 * the new input levels, so a circuit change caused by a write is visible to the firmware at the
 * SAME virtual ns; an external change (the PERMIT switch, a mirror command with atSimNs) applies
 * at the first command tick at or after its time (tick = 1 ms of virtual time).
 *
 * Asserted, per language, on two runs with the PERMIT switch opened at 3.0 s and closed at 4.4 s
 * (virtual time, queued before Run):
 * - every GPIO18 write is followed, at the same vns, by a solve whose GPIO4 level = request ·
 *   permit (the same vns holds by construction — the blocking exchange; the evidence that the
 *   firmware actually SAW that level is the next point);
 * - each printed line's FB equals that level and its verdict (GRANTED / DENIED / released) follows,
 *   with DENIED exactly for the requests while the permit was open; repeated transitions;
 * - each scheduled toggle applies at a tick ≥ its atSimNs and < atSimNs + 1 ms (measured error);
 * - the trace (virtual stamps only) and the serial transcript are identical on both runs;
 * - the host's solve cost (wall-clock, measurement only) is recorded as evidence.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PROTOCOL, type CreateSessionRequest } from '../host/protocol.js';
import type { HostSession, TimingTraceEntry } from '../host/session.js';
import { serialText, waitState } from '../host/tests/support.js';
import { open } from '../host/tests/r1-support.js';
import { principalFor } from '../identity/test-gate.js';
import { recordEvidence } from '../harness/env.js';
import { realHost } from './r2-support.js';
import { MpyStack, RT, V4, builtExample } from './s24-support.js';

const stack = RT && V4 ? new MpyStack() : null;
const host = realHost(
  stack ? { artifactsDir: stack.store, leaseMs: 600_000, timingTraceCapacity: 50_000 } : {},
);
const arduinoHost = realHost(RT && V4 ? { leaseMs: 600_000, timingTraceCapacity: 50_000 } : {});
afterAll(async () => {
  await host.shutdown();
  await arduinoHost.shutdown();
  stack?.cleanup();
});

const OPEN_AT = 3_000_000_000n;
const CLOSE_AT = 4_400_000_000n;
const END = 6_000_000_000n;
const TICK = 1_000_000n;

const fixture = (id: string) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/s30-${id}-session.json`, import.meta.url), 'utf8'),
  ) as { request: Omit<CreateSessionRequest, 'artifact' | 'ticket'> };
const programOf = (id: string) =>
  Object.values(
    (
      JSON.parse(
        readFileSync(new URL(`../../app/src/examples/data/${id}.json`, import.meta.url), 'utf8'),
      ) as { programs: Record<string, { text: string }> }
    ).programs,
  )[0]!.text;

async function session(id: string): Promise<HostSession> {
  const { request } = fixture(id);
  let s: HostSession;
  if (id.startsWith('mpy')) {
    const build = await stack!.build(programOf(id));
    const l = stack!.service.lease(principalFor(), build.artifact!.sha256, 600_000)!;
    s = open(host, {
      ...request,
      protocol: PROTOCOL,
      artifact: { sha256: build.artifact!.sha256 },
      ticket: l.ticket,
    });
  } else {
    const b = await builtExample(id);
    s = open(arduinoHost, {
      ...request,
      protocol: PROTOCOL,
      artifact: { sha256: b.sha256 },
      ticket: b.ticket(),
    });
  }
  expect(s.state, JSON.stringify(s.status().detail)).toBe('ready');
  let rev = request.circuit.projectRevision;
  for (const [i, [at, closed]] of (
    [
      [OPEN_AT, false],
      [CLOSE_AT, true],
    ] as const
  ).entries())
    expect(
      s.submit({
        category: 'mirror',
        seq: i + 1,
        atSimNs: at.toString(),
        projectRevision: ++rev,
        component: 'SW1',
        control: { closed },
      }),
    ).toMatchObject({ accepted: true });
  expect(s.run()).toEqual({ ok: true });
  await expect
    .poll(() => BigInt(s.status().simNs) >= END, { timeout: 300_000, interval: 50 })
    .toBe(true);
  s.stop();
  await waitState(s, 'ended', 30_000);
  await s.done();
  return s;
}

const serialUntil = (s: HostSession, until: bigint) =>
  s.log
    .since(0)
    .filter((e) => e.type === 'serial' && e.simNs !== null && BigInt(e.simNs) <= until)
    .map((e) => Buffer.from((e as { data: string }).data, 'base64').toString())
    .join('');

interface Line {
  cycle: number;
  req: number;
  fb: number;
  verdict: string;
}
const parse = (text: string): Line[] =>
  [...text.matchAll(/#(\d+) REQ=(\d) FB=(\d) (\w+) granted=\d+ denied=\d+ (?:cycles|us)=\d+/g)].map(
    (m) => ({ cycle: +m[1]!, req: +m[2]!, fb: +m[3]!, verdict: m[4]! }),
  );

/** The trace up to END with the wall-clock measurement removed (what must reproduce). */
const virtual = (t: readonly TimingTraceEntry[]) =>
  t
    .filter((e) => BigInt(e.vns) <= END)
    .map((e) => (e.kind === 'solve' ? { ...e, wallUs: undefined } : e));
const sha16 = (x: unknown) =>
  createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 16);

function analyse(s: HostSession) {
  const { entries, dropped } = s.timingTrace();
  expect(dropped).toBe(0);
  const lines = parse(serialText(s));
  // Walk the trace: the permit state, GPIO18's level and GPIO4's injected level over time.
  let permit = true;
  let fb4: 0 | 1 = 0;
  let pending: { vns: bigint; req: number } | null = null;
  const writes: { vns: bigint; req: number; fb: number; permit: boolean }[] = [];
  const controls: bigint[] = [];
  for (const e of entries) {
    if (e.kind === 'control') {
      controls.push(BigInt(e.vns));
      permit = controls.length === 1 ? false : true;
    } else if (e.kind === 'pad' && e.pad === 18 && e.mode !== 'input') {
      pending = { vns: BigInt(e.vns), req: e.mode === 'output-high' ? 1 : 0 };
    } else if (e.kind === 'solve') {
      for (const i of e.injects) if (i.pad === 4) fb4 = i.level;
      if (pending && BigInt(e.vns) === pending.vns) {
        writes.push({ ...pending, fb: fb4, permit });
        pending = null;
      }
    }
  }
  return { entries, lines, writes, controls };
}

for (const id of ['esp32-logic-feedback', 'mpy-logic-feedback'])
  describe.skipIf(!RT || !V4)(`Sprint 30 co-simulation POC: ${id} (real QEMU)`, () => {
    it('firmware → logic → firmware at the same virtual ns; DENIED exactly while the permit is open; scheduled toggles within one tick; trace and transcript reproduce', async () => {
      const runs = [await session(id), await session(id)];
      const a = runs.map(analyse);
      for (const r of a) {
        // Every request write: GPIO4 (the gate) = request · permit, in the SAME solve (vns).
        expect(r.writes.length).toBeGreaterThan(8);
        for (const w of r.writes) expect(w.fb, `@${w.vns}`).toBe(+(w.req === 1 && w.permit));
        // The firmware read what the circuit gave it, line for line (setup()'s LOW write first).
        // Paired from the start (review M3): the first request write is the loop's first line;
        // setup()'s LOW write (and MicroPython's Pin(…, value=0)) precede it; writes after the last
        // printed line (at the stop) are simply not paired.
        const first = r.writes.findIndex((w) => w.req === 1);
        expect(first).toBeGreaterThanOrEqual(0);
        const reqWrites = r.writes.slice(first);
        expect(reqWrites.length).toBeGreaterThanOrEqual(r.lines.length);
        expect(r.lines.length).toBeGreaterThan(8);
        r.lines.forEach((l, k) => {
          expect(l.req, `line ${k}`).toBe(reqWrites[k]!.req);
          expect(l.fb, `line ${k}`).toBe(reqWrites[k]!.fb);
          expect(l.verdict, `line ${k}`).toBe(
            l.req ? (l.fb ? 'GRANTED' : 'DENIED') : l.fb ? 'FAULT' : 'released',
          );
        });
        const verdicts = new Set(r.lines.map((l) => l.verdict));
        expect([...verdicts].sort()).toEqual(['DENIED', 'GRANTED', 'released']);
        // Each scheduled toggle: applied at the first tick at or after its time (< 1 ms late).
        expect(r.controls.length).toBe(2);
        for (const [k, at] of [OPEN_AT, CLOSE_AT].entries()) {
          expect(r.controls[k]! >= at).toBe(true);
          expect(r.controls[k]! - at < TICK).toBe(true);
        }
      }
      // Determinism: the virtual trace and the transcript are identical on both runs.
      const fp = a.map((r) => sha16(virtual(r.entries)));
      expect(fp[1]).toBe(fp[0]);
      // The transcript up to END in virtual time (each run is stopped at a wall-clock poll after
      // END, so the tails differ in length; the serial events carry their window's vns).
      expect(serialUntil(runs[1]!, END)).toBe(serialUntil(runs[0]!, END));
      expect(serialUntil(runs[0]!, END).length).toBeGreaterThan(400);
      // Overhead (wall clock, measurement only).
      const wall = a[0]!.entries
        .flatMap((e) => (e.kind === 'solve' ? [e.wallUs] : []))
        .sort((x, y) => x - y);
      const q = (p: number) => wall[Math.min(wall.length - 1, Math.floor(p * wall.length))]!;
      recordEvidence(`s30-cosim-${id}`, {
        fingerprint: fp[0],
        solves: wall.length,
        writes: a[0]!.writes.length,
        lines: a[0]!.lines.slice(0, 12),
        toggleErrorNs: a[0]!.controls.map((c, k) => (c - [OPEN_AT, CLOSE_AT][k]!).toString()),
        solveWallUs: { p50: q(0.5), p95: q(0.95), max: wall.at(-1) },
        serialHead: serialText(runs[0]!).slice(0, 600),
      });
    }, 900_000);
  });

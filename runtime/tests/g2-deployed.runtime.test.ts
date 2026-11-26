/**
 * K2-b / BETA-G2: queue load harness against the DEPLOYED STAGING instance (`tbi-s8`), never any other.
 * Plan of record: reports/2026-11-24-fable52-k2k3-plan.md section 3.
 *
 * 17 identities (the c5-deployed root relays and `x-forwarded-user`): 15 Free + 2 preview.
 * 4 Free run, 10 queue, and 1 more only probes the pause.
 *  1. Builds: two unique sketches built concurrently (each must finish or be refused explicitly <= 600 s).
 *  2. Admission: 4 Free + 2 preview get 201 (6 live); 10 more Free with `Tbi-Queue: 1` get 202 at
 *     positions 1..10. Free live sessions never exceed 4 (sampled each second, own sessions' state);
 *     live sessions on the host never exceed 6 (/health capacity).
 *  3. Cancel: the last waiter cancels (204) and `waiting` drops by one.
 *  4. Pause drill: `free-admission.paused` created -> a new Free request gets 429 `free_paused` within 5 s,
 *     waiting Free are removed (`waiting` 0, polled for up to 10 s and before any waiter could have
 *     vanished), running Free and preview sessions are untouched; the file is
 *     removed -> admission is back (202, the seats are full). Removed waiters then queue again.
 *  5. Drain: sessions are created with limits.maxLifetimeMs = 120 s (allowed: only stricter than the plan),
 *     so seats free themselves; every waiter is promoted (201) in FIFO order, the head within
 *     pollAfterS + 30 s of a free seat.
 *  6. Clean-up: every session ended; `waiting` back to 0; no principal, token or ticket in the journal.
 *  A failed run writes results/g2-deployed-<run>-FAILED.json (counts and timings only).
 *  Idle drill (idle_timeout, presence): TODO until K3-1 (idle) exists, see it.todo below.
 * Light workload only (TBI_C5_WORKLOAD=gpio, the default here).
 *
 * RUNBOOK (interactive only, daytime, never from the night runner; staging only):
 *   1. Staging installed per the plan (policy.beta.json, TBI_HOST_MAX_SESSIONS=6, metering on); the two
 *      preview identities are mapped to `preview` in the server's policy copy (not in the repo).
 *   2. Take the pipeline lock (deploy/ops/pipeline-lock.mjs acquire), up to 90 min; stop if available
 *      memory drops below 300 MiB.
 *   3. TBI_G2_DEPLOYED=tbi-s8 TBI_ALLOW_SERVICE_MUTATION=tbi-s8 TBI_G2_PREVIEW_USERS=<id1>,<id2> \
 *      [TBI_G2_SECONDS=1500] npx vitest run --config vitest.runtime.config.ts \
 *      runtime/tests/g2-deployed.runtime.test.ts
 *   4. Without TBI_G2_DEPLOYED the file does nothing. With it set, a wrong instance, a missing mutation
 *      opt-in, no lock or wrong preview list FAILS the test (g2-guard.ts, unit-tested offline in
 *      scripts/tests/g2-deployed-guard.test.mjs). The only mutation is creating/removing the pause file
 *      (and the harness's own sessions); the file is removed again in a finally block.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it, onTestFailed } from 'vitest';
import { DEFAULT_CONFIG } from '../plans/config.js';
import { recordEvidence } from '../harness/env.js';
import { Circuit } from '../host/tests/r1-support.js';
import { PROTOCOL } from '../host/protocol.js';
import { mutationAllowed } from './mutation-gate.js';
import {
  g2Decision,
  g2FailedReport,
  g2FreeUsers,
  pollUntil,
  G2_ENV,
  G2_FREE_LIVE,
  G2_PAUSE_PROBE,
  G2_PAUSE_REMOVAL_MS,
  G2_PREVIEW,
  G2_QUEUED,
  G2_STAGING,
  type G2Progress,
} from './g2-guard.js';

const decision = g2Decision();
const INSTANCE = G2_STAGING;
const SECONDS = Number(process.env.TBI_G2_SECONDS ?? 1500);
const LIFETIME_MS = 120_000;
const RUN = Date.now().toString(36);
const sudo = (...args: string[]) => spawnSync('sudo', ['-n', ...args], { encoding: 'utf8' });
const PAUSE_FILE = `/var/lib/${INSTANCE}-runtime/state/sim/free-admission.paused`;

const relays: ChildProcess[] = [];
async function relay(socket: string): Promise<string> {
  const port = 5800 + Math.floor(Math.random() * 150);
  const code = `const net=require('node:net');net.createServer((c)=>{const u=net.connect(${JSON.stringify(socket)});c.pipe(u).pipe(c);u.on('error',()=>c.destroy());c.on('error',()=>u.destroy())}).listen(${port},'127.0.0.1',()=>console.log('ready'));`;
  const child = spawn('sudo', ['-n', process.execPath, '-e', code], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  relays.push(child);
  await new Promise<void>((r) => child.stdout!.on('data', () => r()));
  return `http://127.0.0.1:${port}`;
}
afterAll(() => {
  for (const r of relays)
    for (const c of spawnSync('pgrep', ['-P', String(r.pid)])
      .stdout.toString()
      .split(/\s+/)
      .filter(Boolean))
      sudo('kill', c);
});

const as = (user: string, extra: Record<string, string> = {}) => ({
  'x-forwarded-user': user,
  ...extra,
});
const json = async (r: Response) => ({
  status: r.status,
  headers: r.headers,
  body: (await r.json().catch(() => ({}))) as Record<string, any>,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const gpioCircuit = () => {
  const c = new Circuit().psu(3.3);
  const r = c.add('component.resistor');
  const d = c.add('component.led');
  c.ohms(r, 220).wire(`${r}.b`, `${d}.anode`).wire(`${d}.cathode`, 'GND1.ref');
  return c.pad(2, `${r}.a`);
};
const sketch = (tag: string) =>
  `${readFileSync(new URL('../firmware/arduino/TbiGpioProof/TbiGpioProof.ino', import.meta.url), 'utf8')}\n// g2-deployed ${tag}\n`;

describe('G2 deployed: queue under load on staging', () => {
  it.skipIf(decision.kind === 'off')(
    `${G2_ENV}: guard, then the ${G2_PAUSE_PROBE + 1 + G2_PREVIEW}-identity queue drill`,
    async () => {
      // Refusal is a FAILURE, never a skip (a green no-op would be a false result).
      if (decision.kind === 'refused') throw new Error(`g2-deployed refused: ${decision.reason}`);
      if (decision.kind !== 'run') return;
      // Belt and braces: the shared gate itself, evaluated again at the point of mutation.
      if (!mutationAllowed(INSTANCE)) throw new Error('g2-deployed refused: mutation gate');
      if (sudo('test', '-f', `/etc/systemd/system/${INSTANCE}-session-host.service`).status !== 0)
        throw new Error(`g2-deployed: ${INSTANCE} is not installed on this host`);

      const BUILD = await relay(`/run/${INSTANCE}-build/api.sock`);
      const HOST = await relay(`/run/${INSTANCE}-runtime/api.sock`);
      const HEALTH = await relay(`/run/${INSTANCE}-runtime/health.sock`);
      const free = g2FreeUsers(RUN);
      const preview = decision.previewUsers;
      const t00 = performance.now();
      const health = async () =>
        (await json(await fetch(`${HEALTH}/health`))).body.capacity as {
          live: number;
          max: number;
          waiting?: number;
          metered?: number;
          freePaused?: boolean;
        };

      const progress: G2Progress = {
        instance: INSTANCE,
        phase: 'builds',
        seconds: 0,
        admitted: [],
        builds: [],
        promotedPositions: [],
        samples: [],
      };
      // Also covers failed builds and a test timeout, which a finally block would not.
      onTestFailed(() => {
        progress.seconds = Math.round((performance.now() - t00) / 1000);
        recordEvidence(`g2-deployed-${RUN}-FAILED`, g2FailedReport(progress));
      });

      // ---- 1. builds
      const buildFor = async (user: string, text: string) => {
        const t0 = performance.now();
        const s = await json(
          await fetch(`${BUILD}/v1/builds`, {
            method: 'POST',
            headers: as(user, { 'content-type': 'application/json' }),
            body: JSON.stringify({
              protocol: 'tbi-lab.build/1',
              profile: 'esp32-arduino-3.3.12',
              files: [{ name: 'sketch.ino', text }],
            }),
          }),
        );
        let sha: string | undefined;
        if (s.status === 200) sha = s.body.build?.artifact?.sha256;
        else if (s.status === 202)
          for (;;) {
            const st = (await (
              await fetch(`${BUILD}/v1/builds/${s.body.buildId}`, {
                headers: as(user, { authorization: `Bearer ${s.body.token}` }),
              })
            ).json()) as { state: string; result?: { artifact?: { sha256: string } } };
            if (st.state === 'succeeded') {
              sha = st.result?.artifact?.sha256;
              break;
            }
            if (st.state === 'failed') break;
            if (performance.now() - t0 > 600_000) break;
            await sleep(500);
          }
        const ms = Math.round(performance.now() - t0);
        progress.builds.push({ status: s.status, ms });
        return { user, status: s.status, sha, ms };
      };
      const everyone = [...free, ...preview];
      const unique = await Promise.all([
        buildFor(everyone[0]!, sketch(`${RUN}-a`)),
        buildFor(everyone[1]!, sketch(`${RUN}-b`)),
      ]);
      const shaOf = new Map<string, string>();
      for (const b of unique) {
        expect(b.sha, `unique build of ${b.user} (status ${b.status}) must succeed`).toBeTruthy();
        shaOf.set(b.user, b.sha!);
      }
      const others = [];
      for (const u of everyone.slice(2)) {
        const b = await buildFor(u, sketch(`${RUN}-a`));
        expect(b.sha, `build of ${u} (status ${b.status}) must succeed`).toBeTruthy();
        shaOf.set(u, b.sha!);
        others.push({ status: b.status, ms: b.ms });
      }

      // ---- session helpers
      interface Mine {
        user: string;
        plan: 'free' | 'preview';
        id: string;
        token: string;
        createdMs: number;
        terminalMs?: number;
      }
      const mine: Mine[] = [];
      const create = async (user: string, ticket?: string) => {
        const sha = shaOf.get(user)!;
        const l = await json(
          await fetch(`${BUILD}/v1/artifacts/${sha}/lease`, { method: 'POST', headers: as(user) }),
        );
        const req = gpioCircuit().request(sha);
        const r = await json(
          await fetch(`${HOST}/sessions`, {
            method: 'POST',
            headers: as(user, {
              'content-type': 'application/json',
              'tbi-queue': '1',
              ...(ticket ? { 'tbi-queue-ticket': ticket } : {}),
            }),
            body: JSON.stringify({
              ...req,
              protocol: PROTOCOL,
              artifact: { sha256: sha },
              ticket: l.body.ticket,
              limits: { maxLifetimeMs: LIFETIME_MS },
            }),
          }),
        );
        if (r.status === 201) {
          const m: Mine = {
            user,
            plan: preview.includes(user) ? 'preview' : 'free',
            id: r.body.sessionId,
            token: r.body.token,
            createdMs: performance.now(),
          };
          mine.push(m);
          await fetch(`${HOST}/sessions/${m.id}/run`, {
            method: 'POST',
            headers: as(user, { authorization: `Bearer ${m.token}` }),
          });
        }
        return r;
      };
      const stateOf = async (m: Mine) =>
        (
          await json(
            await fetch(`${HOST}/sessions/${m.id}`, {
              headers: as(m.user, { authorization: `Bearer ${m.token}` }),
            }),
          )
        ).body.state as string;
      const isEnded = (s: string) => s === 'ended' || s === 'failed';
      /** One pass: own live Free count and host live; throws on a breach (explicit failure). */
      const { samples, admitted } = progress;
      const sample = async () => {
        let freeLive = 0;
        for (const m of mine) {
          if (m.terminalMs !== undefined) continue;
          const s = await stateOf(m);
          if (isEnded(s)) m.terminalMs = performance.now();
          else if (m.plan === 'free') freeLive++;
        }
        const hostLive = (await health()).live;
        samples.push({ freeLive, hostLive });
        expect(freeLive, 'Free live sessions must never exceed 4').toBeLessThanOrEqual(
          G2_FREE_LIVE,
        );
        expect(hostLive, 'host live sessions must never exceed 6').toBeLessThanOrEqual(
          G2_FREE_LIVE + G2_PREVIEW,
        );
      };

      let pauseCreated = false;
      try {
        // ---- 2. admission
        progress.phase = 'admission';
        for (const u of [...free.slice(0, G2_FREE_LIVE), ...preview])
          admitted.push((await create(u)).status);
        expect(admitted).toEqual(Array(G2_FREE_LIVE + G2_PREVIEW).fill(201));
        const queuedUsers = free.slice(G2_FREE_LIVE, G2_FREE_LIVE + G2_QUEUED);
        interface Waiter {
          user: string;
          ticket: string;
          pollAfterS: number;
          position: number;
          done?: { status: number; atMs: number; error?: unknown };
        }
        let waiters: Waiter[] = [];
        const enqueue = async (users: string[]) => {
          const out: Waiter[] = [];
          for (const [i, user] of users.entries()) {
            const r = await create(user);
            expect(r.status, `queue join of ${user}: ${JSON.stringify(r.body)}`).toBe(202);
            const q = r.body.queued as { ticket: string; position: number; pollAfterS: number };
            expect(q.position).toBe(i + 1);
            expect(r.body.error).not.toBe('runtime_capacity');
            out.push({ user, ticket: q.ticket, pollAfterS: q.pollAfterS, position: q.position });
          }
          return out;
        };
        const firstJoinAt = performance.now();
        waiters = await enqueue(queuedUsers);
        await sample();
        expect((await health()).waiting).toBe(G2_QUEUED);

        // ---- 3. cancel
        progress.phase = 'cancel';
        const last = waiters.pop()!;
        const c = await fetch(`${HOST}/sessions/queue`, {
          method: 'DELETE',
          headers: as(last.user, { 'tbi-queue-ticket': last.ticket }),
        });
        expect(c.status).toBe(204);
        expect((await health()).waiting).toBe(G2_QUEUED - 1);

        // ---- 4. pause drill
        progress.phase = 'pause';
        const tPause = performance.now();
        expect(sudo('touch', PAUSE_FILE).status).toBe(0);
        pauseCreated = true;
        let pausedAnswer = 0;
        while (performance.now() - tPause < 5000 && pausedAnswer !== 429) {
          pausedAnswer = (await create(free[G2_PAUSE_PROBE]!)).status;
          if (pausedAnswer !== 429) await sleep(500);
        }
        expect(pausedAnswer, 'free_paused (429) within 5 s').toBe(429);
        const refusal = await create(free[G2_PAUSE_PROBE]!);
        expect(refusal.body.error).toBe('free_paused');
        // after vanishMs without a poll a waiter leaves anyway, which would prove nothing
        const removed = await pollUntil(
          async () => (await health()).waiting,
          (w) => w === 0,
          Math.min(tPause + G2_PAUSE_REMOVAL_MS, firstJoinAt + DEFAULT_CONFIG.queue.vanishMs),
        );
        expect(
          removed.ok,
          `waiting Free removed by the pause: waiting=${removed.value}, ${Math.round(removed.atMs - tPause)} ms after the pause, ${Math.round(removed.atMs - firstJoinAt)} ms after the first join`,
        ).toBe(true);
        await sample(); // running Free and preview sessions are untouched (still counted, none ended)
        expect(
          mine.filter(
            (m) => m.terminalMs !== undefined && performance.now() - m.createdMs < 60_000,
          ),
        ).toEqual([]);
        expect(sudo('rm', '-f', PAUSE_FILE).status).toBe(0);
        pauseCreated = false;
        const back = await create(free[G2_PAUSE_PROBE]!);
        expect([201, 202], `admission after removal: ${JSON.stringify(back.body)}`).toContain(
          back.status,
        );
        if (back.status === 202)
          await fetch(`${HOST}/sessions/queue`, {
            method: 'DELETE',
            headers: as(free[G2_PAUSE_PROBE]!, {
              'tbi-queue-ticket': back.body.queued.ticket,
            }),
          });
        // the waiters the pause removed queue again (their old tickets keep answering free_paused)
        waiters = await enqueue(waiters.map((w) => w.user));

        // ---- 5. drain: poll every pollAfterS; seats free themselves at the 120 s lifetime
        progress.phase = 'drain';
        const promoted: { user: string; atMs: number; position: number }[] = [];
        const deadline = performance.now() + SECONDS * 1000;
        const poller = async (w: Waiter) => {
          while (performance.now() < deadline && !w.done) {
            await sleep(w.pollAfterS * 1000);
            const r = await create(w.user, w.ticket);
            if (r.status === 202) continue;
            w.done = { status: r.status, atMs: performance.now(), error: r.body.error };
            if (r.status === 201) {
              promoted.push({ user: w.user, atMs: w.done.atMs, position: w.position });
              progress.promotedPositions.push(w.position);
            }
          }
        };
        const pollers = waiters.map(poller);
        while (performance.now() < deadline && waiters.some((w) => !w.done)) {
          await sample();
          await sleep(1000);
        }
        await Promise.all(pollers);
        expect(
          waiters.filter((w) => w.done?.status !== 201).map((w) => [w.user, w.done]),
          'every waiter promoted',
        ).toEqual([]);
        // FIFO: promotions arrive in queue position order within one poll round of each other
        const positions = promoted.sort((a, b) => a.atMs - b.atMs).map((p) => p.position);
        const inversions = positions.filter((p, i) => i > 0 && p < positions[i - 1]! - 0).length;
        expect(inversions, `promotion order ${positions.join(',')} must be FIFO`).toBe(0);
        // head promotion gap: first seat freed -> first 201, <= pollAfterS + 30 s
        const firstFree = Math.min(
          ...mine.filter((m) => m.terminalMs !== undefined).map((m) => m.terminalMs!),
        );
        const gapS = (promoted[0]!.atMs - firstFree) / 1000;
        expect(gapS, 'head of the queue promoted within pollAfterS + 30 s').toBeLessThanOrEqual(
          waiters[0]!.pollAfterS + 30,
        );

        // ---- 6. clean-up
        progress.phase = 'clean-up';
        for (const m of mine)
          await fetch(`${HOST}/sessions/${m.id}`, {
            method: 'DELETE',
            headers: as(m.user, { authorization: `Bearer ${m.token}` }),
          });
        await sleep(3000);
        const end = await health();
        expect(end.live).toBe(0);
        expect(end.waiting ?? 0).toBe(0);
        const journal = sudo(
          'journalctl',
          '-u',
          `${INSTANCE}-session-host`,
          '--no-pager',
          '-o',
          'cat',
          '--since',
          `-${Math.ceil((performance.now() - t00) / 60000) + 2}min`,
        ).stdout;
        for (const secret of [
          ...everyone,
          ...mine.map((m) => m.token),
          ...waiters.map((w) => w.ticket),
        ])
          expect(journal.includes(secret), 'no principal, token or ticket in the journal').toBe(
            false,
          );

        recordEvidence(`g2-deployed-${RUN}`, {
          instance: INSTANCE,
          admitted,
          unique,
          others,
          positions,
          headPromotionGapS: gapS,
          maxFreeLive: Math.max(...samples.map((s) => s.freeLive)),
          maxHostLive: Math.max(...samples.map((s) => s.hostLive)),
          seconds: Math.round((performance.now() - t00) / 1000),
        });
      } finally {
        if (pauseCreated) sudo('rm', '-f', PAUSE_FILE);
        for (const m of mine)
          await fetch(`${HOST}/sessions/${m.id}`, {
            method: 'DELETE',
            headers: as(m.user, { authorization: `Bearer ${m.token}` }),
          }).catch(() => undefined);
      }
    },
    SECONDS * 1000 + 900_000,
  );

  // The idle drill needs the K3-1 idle timeout (idleMs, presence). Not testable before it exists.
  it.todo(
    'idle drill: open stream without commands -> idle_timeout at idleMs +/- 2 s; presence survives (K3-1)',
  );
});

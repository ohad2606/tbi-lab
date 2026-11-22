/**
 * TBI-018 slice 3c: SimHostAdapter, the thin layer between the Session Host and SimMeter + FairQueue.
 * NOT WIRED: the Session Host refuses to start with an enabled adapter until the host slice lands
 * (runtime/host/host.ts, see docs/plans/TBI-018-host-integration.md). metering.enabled=false (the
 * default) makes every call answer { metered: false } and do nothing, so the host behaves as today.
 *
 * The host calls, in order:
 *   admit(req)          at session open, and again on every poll of a queued client (same ticket).
 *                       start   = the meter opened the session (plan FIXED here, for the whole run);
 *                       queued  = wait, poll again; refused = explicit LimitError, nothing opened.
 *   heartbeat(id)       while the run lives (and when remainingMs elapses). continue = keep running,
 *                       arm a stop timer at remainingMs; stop = end the run now with the error.
 *                       Billing is capped at the heartbeat that detected 0 (overshoot <= one interval).
 *   ended(id, reason)   once the host session is terminal: bills (idempotent), starts the Free cooldown.
 *   housekeeping()      on the host timer: drops timed-out / vanished waiters, bills lease-lost runs.
 *
 * Fairness: every request goes through the queue, so a newcomer never jumps a waiting entry; it starts
 * only when it is the first eligible entry and a slot is free. A direct start therefore also obeys the
 * Free cooldown (enqueue checks FairQueue.cooldownMs; s3b follow-up). Free slot cap counts plan 'free' only; legacy is
 * ranked with Advanced and is not under the Free cap (owner decision 2026-11-22).
 * Running count: the larger of the host's count and the sessions this adapter admitted and the host has
 * not reported ended (the host's picture may lag a concurrent admit). One serial mutex.
 * Fail closed: any meter problem refuses (admit) or stops (heartbeat) with system_unavailable.
 */
import type { PlanId, PlansConfig } from './config.js';
import { PLAN_IDS } from './config.js';
import { limitError, type LimitError } from './limits.js';
import { FairQueue, type Dropped } from './queue.js';
import { SimMeter, type CloseReason, type SimEvent } from './simminutes.js';
import type { Store } from './store.js';
import type { Clock } from './time.js';

/** The host's slot picture at the moment of the call. The capacity is the host's, never assumed. */
export interface HostSlots {
  capacity: number;
  running: number;
  /** queue.freeCapMode = liftUntilFirstPaid only */
  anyPaidUser?: boolean;
}

export interface HostAdmitRequest {
  /** opaque id of the waiting request; the client sends it again on each poll */
  ticket: string;
  /** the host session id the run will have */
  sessionId: string;
  principal: string;
  /** the plan resolved by the host at this moment; fixed for the run once it starts */
  plan: PlanId;
  slots: HostSlots;
}

type Off = { metered: false };
const OFF: Off = { metered: false };

export type HostAdmit =
  | Off
  | {
      metered: true;
      decision: 'start';
      sessionId: string;
      plan: PlanId;
      /** ms left (smaller of month and day); null = no sim limit for this plan */
      remainingMs: number | null;
      dropped: Dropped[];
    }
  | { metered: true; decision: 'queued'; position: number; status: LimitError; dropped: Dropped[] }
  | { metered: true; decision: 'refused'; error: LimitError; dropped: Dropped[] };

export type HostBeat =
  | Off
  | { metered: true; decision: 'continue'; remainingMs: number | null }
  | { metered: true; decision: 'stop'; error: LimitError };

export type HostEnd =
  | Off
  | { metered: true; ok: true; billedMs: number }
  | { metered: true; ok: false; error: LimitError };

export type HostHousekeeping =
  | Off
  | { metered: true; ok: true; closed: number; dropped: Dropped[] }
  | { metered: true; ok: false; error: LimitError; dropped: Dropped[] };

/** Host end reason -> meter close reason. Billing is the same formula for all of them. */
export function closeReasonOf(hostReason: string): CloseReason {
  if (hostReason === 'lease_expired') return 'lease';
  if (hostReason === 'host_shutdown') return 'host';
  return 'ended';
}

const minLeft = (r: { monthMs: number | null; dayMs: number | null }): number | null => {
  const left = [r.monthMs, r.dayMs].filter((x): x is number => x !== null);
  return left.length ? Math.min(...left) : null;
};

export interface SimHostOptions {
  config: PlansConfig;
  clock: Clock;
}

export class SimHostAdapter {
  private readonly live = new Map<string, { principal: string; plan: PlanId }>();
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly meter: SimMeter,
    private readonly queue: FairQueue,
    private readonly cfg: PlansConfig,
  ) {}

  static async open(store: Store<SimEvent>, opts: SimHostOptions): Promise<SimHostAdapter> {
    const meter = await SimMeter.open(store, opts);
    return new SimHostAdapter(meter, new FairQueue(opts.config, opts.clock), opts.config);
  }

  get enabled(): boolean {
    return this.cfg.metering.enabled;
  }
  /** sessions admitted and not yet reported ended */
  get tracked(): number {
    return this.live.size;
  }
  get waiting(): number {
    return this.queue.length;
  }
  /** the plan a run was admitted with (fixed at open) */
  planOf(sessionId: string): PlanId | undefined {
    return this.live.get(sessionId)?.plan;
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn);
    this.tail = p.catch(() => undefined);
    return p;
  }

  admit(req: HostAdmitRequest): Promise<HostAdmit> {
    if (!this.enabled) return Promise.resolve(OFF);
    return this.run(async () => {
      const refuse = (error: LimitError, dropped: Dropped[] = []): HostAdmit => ({
        metered: true,
        decision: 'refused',
        error,
        dropped,
      });
      const s = req.slots;
      if (
        !s ||
        !Number.isSafeInteger(s.capacity) ||
        !Number.isSafeInteger(s.running) ||
        s.capacity < 0 ||
        s.running < 0 ||
        !PLAN_IDS.includes(req.plan)
      )
        return refuse(limitError('invalid_request'));
      if (this.live.has(req.sessionId)) return refuse(limitError('invalid_state'));
      if (this.meter.storeProblem) return refuse(limitError('system_unavailable'));
      // s3b follow-up (host must apply the Free cooldown to direct starts): every start, also into an
      // idle slot, goes through enqueue, which refuses a new Free entry with sim_cooldown.
      const ok = this.meter.admissible(req.principal, req.plan);
      if (!ok.ok) {
        this.queue.drop(req.ticket);
        return refuse(ok.error);
      }
      if (!ok.metered) return refuse(limitError('invalid_state')); // metering changed under us
      const used = this.meter.usedTodayMs(req.principal);
      if (!used.ok || !used.metered) return refuse(limitError('system_unavailable'));
      const dropped = this.queue.tick();
      const q = this.queue.enqueue({
        ticket: req.ticket,
        principal: req.principal,
        plan: req.plan,
        simMsToday: used.ms,
      });
      if (!q.ok) return refuse(q.error, dropped);
      const running = Math.max(s.running, this.live.size);
      const runningFree = [...this.live.values()].filter((x) => x.plan === 'free').length;
      const slots = { capacity: s.capacity, running, runningFree, anyPaidUser: s.anyPaidUser };
      const queuedResult = (): HostAdmit => ({
        metered: true,
        decision: 'queued',
        position: this.queue.position(req.ticket) as number,
        status: limitError('queue', { n: this.queue.position(req.ticket) as number }),
        dropped,
      });
      if (running >= s.capacity) return queuedResult();
      const freeFull = runningFree >= this.queue.freeCap(slots);
      const head = this.queue.snapshot().find((e) => !(e.plan === 'free' && freeFull));
      if (!head || head.ticket !== req.ticket) return queuedResult();
      const out = this.queue.dequeue(slots);
      dropped.push(...out.dropped);
      if (out.entry?.ticket !== req.ticket) return refuse(limitError('invalid_state'), dropped);
      const opened = await this.meter.open(req.sessionId, req.principal, out.entry.plan);
      if (!opened.ok) return refuse(opened.error, dropped);
      if (!opened.metered) return refuse(limitError('invalid_state'), dropped);
      this.live.set(req.sessionId, { principal: req.principal, plan: out.entry.plan });
      return {
        metered: true,
        decision: 'start',
        sessionId: req.sessionId,
        plan: out.entry.plan,
        remainingMs: minLeft(opened),
        dropped,
      };
    });
  }

  heartbeat(sessionId: string): Promise<HostBeat> {
    if (!this.enabled) return Promise.resolve(OFF);
    return this.run(async () => {
      if (!this.live.has(sessionId))
        return { metered: true, decision: 'stop', error: limitError('invalid_state') };
      const r = await this.meter.heartbeat(sessionId);
      if (!r.ok) return { metered: true, decision: 'stop', error: r.error };
      if (!r.metered)
        return { metered: true, decision: 'stop', error: limitError('invalid_state') };
      return { metered: true, decision: 'continue', remainingMs: r.remainingMs };
    });
  }

  /** The host session is terminal. Bills it (a second call is a duplicate) and frees the slot. */
  ended(sessionId: string, reason: CloseReason): Promise<HostEnd> {
    if (!this.enabled) return Promise.resolve(OFF);
    return this.run(async () => {
      const s = this.live.get(sessionId);
      this.live.delete(sessionId);
      if (s) this.queue.sessionEnded(s.principal, s.plan);
      const r = await this.meter.close(sessionId, reason);
      if (!r.ok) return { metered: true, ok: false, error: r.error };
      if (!r.metered) return { metered: true, ok: false, error: limitError('invalid_state') };
      return { metered: true, ok: true, billedMs: r.billedMs };
    });
  }

  housekeeping(): Promise<HostHousekeeping> {
    if (!this.enabled) return Promise.resolve(OFF);
    return this.run(async () => {
      const dropped = this.queue.tick();
      const r = await this.meter.sweep();
      if (!r.ok) return { metered: true, ok: false, error: r.error, dropped };
      if (!r.metered)
        return { metered: true, ok: false, error: limitError('invalid_state'), dropped };
      return { metered: true, ok: true, closed: r.closed, dropped };
    });
  }

  /** A waiting client cancelled (or its lease was lost). */
  cancel(ticket: string): Off | { metered: true; cancelled: boolean } {
    if (!this.enabled) return OFF;
    return { metered: true, cancelled: this.queue.drop(ticket) !== null };
  }

  /** A waiting client is still there (between polls). */
  touch(ticket: string): Off | { metered: true; queued: boolean } {
    if (!this.enabled) return OFF;
    return { metered: true, queued: this.queue.touch(ticket) };
  }
}

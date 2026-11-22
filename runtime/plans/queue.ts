/**
 * TBI-018 slice 3b: FairQueue, a PURE, memory-only state machine for waiting ESP32 run requests. INERT:
 * imported by nothing outside runtime/plans in this slice (no Session Host wiring).
 *
 * Order (R4.2): config rank of the plan (default Pro, then Advanced = legacy, then Free), then fewer sim ms
 * today, then FIFO (arrival sequence). Rules: Free slot cap (R4.1, D-3), max wait (R4.3), vanished client
 * (R4.3), max length (R4.6), Free re-queue cooldown (R4.5), drop on lease loss. At most queue.maxFree
 * waiting Free entries (< maxLength), so Free can never fill the whole queue; a full queue is queue_full.
 * A re-enqueue (same ticket, or same principal with a new ticket) refreshes the plan.
 *
 * It never selects a victim (R4.4): it knows running sessions only as counts given by the caller, and
 * `dequeue` returns a waiting entry or nothing. There is no API that ends or names a running session.
 * Time comes only from the injected Clock. Principals are opaque ids; tickets are opaque too.
 */
import type { PlanId, PlansConfig } from './config.js';
import { PLAN_IDS } from './config.js';
import { limitError, validPrincipal, type LimitError } from './limits.js';
import type { Clock } from './time.js';

export interface QueueEntry {
  ticket: string;
  principal: string;
  plan: PlanId;
  /** billed sim ms today at enqueue (a waiting user has no running session, so it does not change) */
  simMsToday: number;
  enqueuedAt: number;
  /** last sign of life of the waiting client (enqueue or touch) */
  leaseAt: number;
  /** arrival order, the FIFO tie-breaker */
  seq: number;
}

export interface EnqueueRequest {
  ticket: string;
  principal: string;
  plan: PlanId;
  simMsToday: number;
}

export type DropReason = 'timeout' | 'vanished' | 'lease_lost' | 'cancelled';

export interface Dropped {
  ticket: string;
  principal: string;
  reason: DropReason;
  /** what the caller tells the client; null = no client to tell */
  error: LimitError | null;
}

/** Slot picture supplied by the host at the moment of a dequeue. The queue never assumes a host cap. */
export interface Slots {
  capacity: number;
  running: number;
  runningFree: number;
  /** used only when queue.freeCapMode = liftUntilFirstPaid */
  anyPaidUser?: boolean;
}

export type EnqueueResult =
  | { ok: true; duplicate: boolean; position: number; status: LimitError }
  | { ok: false; error: LimitError };

const TICKET = /^[A-Za-z0-9_.:-]{1,128}$/;
const fail = (error: LimitError): { ok: false; error: LimitError } => ({ ok: false, error });

export class FairQueue {
  private entries: QueueEntry[] = [];
  private seq = 0;
  /** principal -> time until which a Free enqueue is refused */
  private cooldown = new Map<string, number>();

  constructor(
    private readonly cfg: PlansConfig,
    private readonly clock: Clock,
  ) {}

  /** Sort key comparison; FIFO by seq makes it a stable sort of arrival order. */
  compare(a: QueueEntry, b: QueueEntry): number {
    const r = this.cfg.queue.rank;
    return r[a.plan] - r[b.plan] || a.simMsToday - b.simMsToday || a.seq - b.seq;
  }

  private ordered(): QueueEntry[] {
    return [...this.entries].sort((a, b) => this.compare(a, b));
  }

  /** Waiting entries in service order (copies). */
  snapshot(): QueueEntry[] {
    return this.ordered().map((e) => ({ ...e }));
  }
  get length(): number {
    return this.entries.length;
  }
  /** 1-based place in the service order, or null when not queued. */
  position(ticket: string): number | null {
    const i = this.ordered().findIndex((e) => e.ticket === ticket);
    return i === -1 ? null : i + 1;
  }
  /**
   * ms of Free cooldown left for a principal (0 = none).
   * HOST CONTRACT: the queue enforces the cooldown only on enqueue. A host that starts a Free run
   * directly (a slot is idle, no queue) MUST call cooldownMs(principal) first and refuse with
   * sim_cooldown while it is > 0; otherwise the cooldown is not applied to direct starts.
   */
  cooldownMs(principal: string): number {
    const until = this.cooldown.get(principal);
    return until === undefined ? 0 : Math.max(0, until - this.clock.now());
  }

  enqueue(req: EnqueueRequest): EnqueueResult {
    if (!validPrincipal(req.principal)) return fail(limitError('invalid_principal'));
    if (typeof req.ticket !== 'string' || !TICKET.test(req.ticket))
      return fail(limitError('invalid_request'));
    if (!PLAN_IDS.includes(req.plan)) return fail(limitError('invalid_request'));
    if (!Number.isInteger(req.simMsToday) || req.simMsToday < 0)
      return fail(limitError('invalid_request'));
    const now = this.clock.now();
    const byTicket = this.entries.find((e) => e.ticket === req.ticket);
    if (byTicket && byTicket.principal !== req.principal)
      return fail(limitError('invalid_request'));
    // One waiting entry per principal. A reconnecting client gets a new ticket but keeps its place
    // and its original enqueue time (so the max wait still counts from the first enqueue).
    const existing = byTicket ?? this.entries.find((e) => e.principal === req.principal);
    if (existing) {
      if (req.plan === 'free' && existing.plan !== 'free') {
        // downgraded while waiting: it may not keep a paid place, and Free rules apply to it
        const refusal = this.freeRefusal(req.principal);
        if (refusal) {
          this.entries = this.entries.filter((e) => e !== existing);
          return fail(refusal);
        }
      }
      existing.ticket = req.ticket;
      existing.plan = req.plan;
      existing.leaseAt = now;
      return this.queued(existing.ticket, true);
    }
    if (req.plan === 'free') {
      const refusal = this.freeRefusal(req.principal);
      if (refusal) return fail(refusal);
    }
    if (this.entries.length >= this.cfg.queue.maxLength) return fail(limitError('queue_full'));
    this.entries.push({
      ticket: req.ticket,
      principal: req.principal,
      plan: req.plan,
      simMsToday: req.simMsToday,
      enqueuedAt: now,
      leaseAt: now,
      seq: ++this.seq,
    });
    return this.queued(req.ticket, false);
  }

  /** Why a Free entry of `principal` may not join now (cooldown, Free share full), or null. */
  private freeRefusal(principal: string): LimitError | null {
    const left = this.cooldownMs(principal);
    if (left > 0) return limitError('sim_cooldown', { n: Math.ceil(left / 1000) });
    const free = this.entries.filter((e) => e.plan === 'free').length;
    if (free >= this.cfg.queue.maxFree) return limitError('queue_full');
    return null;
  }

  private queued(ticket: string, duplicate: boolean): EnqueueResult {
    const position = this.position(ticket) as number;
    return { ok: true, duplicate, position, status: limitError('queue', { n: position }) };
  }

  /** The waiting client is still there (its poll). Returns false when the ticket is not queued. */
  touch(ticket: string): boolean {
    const e = this.entries.find((x) => x.ticket === ticket);
    if (!e) return false;
    e.leaseAt = Math.max(e.leaseAt, this.clock.now());
    return true;
  }

  /** Remove a waiting entry (client cancelled, or its lease was lost). */
  drop(ticket: string, reason: 'cancelled' | 'lease_lost' = 'cancelled'): Dropped | null {
    const i = this.entries.findIndex((x) => x.ticket === ticket);
    if (i === -1) return null;
    const [e] = this.entries.splice(i, 1) as [QueueEntry];
    return {
      ticket: e.ticket,
      principal: e.principal,
      reason,
      error: reason === 'lease_lost' ? limitError('lease_lost') : null,
    };
  }

  /** A run of `principal` ended: a Free plan starts its re-queue cooldown. */
  sessionEnded(principal: string, plan: PlanId): void {
    if (plan !== 'free' || this.cfg.queue.freeCooldownMs === 0) return;
    this.cooldown.set(principal, this.clock.now() + this.cfg.queue.freeCooldownMs);
  }

  /** Drop entries that waited too long or whose client vanished; forget finished cooldowns. */
  tick(): Dropped[] {
    const now = this.clock.now();
    const q = this.cfg.queue;
    const out: Dropped[] = [];
    this.entries = this.entries.filter((e) => {
      if (now - e.enqueuedAt >= q.maxWaitMs) {
        out.push({
          ticket: e.ticket,
          principal: e.principal,
          reason: 'timeout',
          error: limitError('queue_timeout'),
        });
        return false;
      }
      if (now - e.leaseAt >= q.vanishMs) {
        out.push({
          ticket: e.ticket,
          principal: e.principal,
          reason: 'vanished',
          error: limitError('queue_vanished'),
        });
        return false;
      }
      return true;
    });
    for (const [p, until] of this.cooldown) if (until <= now) this.cooldown.delete(p);
    return out;
  }

  /** Most slots Free may hold right now. Never more than the capacity. */
  freeCap(slots: Slots): number {
    const q = this.cfg.queue;
    const cap =
      q.freeCapMode === 'liftUntilFirstPaid' && slots.anyPaidUser === false
        ? slots.capacity
        : q.freeSlotCap;
    return Math.min(cap, slots.capacity);
  }

  /**
   * Hand the next waiting entry a free slot, if any. Runs tick() first (its drops are returned so the
   * caller can tell those clients). A Free entry is skipped while Free already holds its cap; a paid
   * entry behind it may then start. A full host gives nothing: no running session is ever displaced.
   */
  dequeue(slots: Slots): { entry: QueueEntry | null; dropped: Dropped[] } {
    const dropped = this.tick();
    const okSlots =
      Number.isInteger(slots.capacity) &&
      Number.isInteger(slots.running) &&
      Number.isInteger(slots.runningFree) &&
      slots.capacity >= 0 &&
      slots.running >= 0 &&
      slots.runningFree >= 0 &&
      slots.runningFree <= slots.running;
    if (!okSlots || slots.running >= slots.capacity) return { entry: null, dropped };
    const freeFull = slots.runningFree >= this.freeCap(slots);
    const next = this.ordered().find((e) => !(e.plan === 'free' && freeFull));
    if (!next) return { entry: null, dropped };
    this.entries = this.entries.filter((e) => e !== next);
    return { entry: { ...next }, dropped };
  }
}

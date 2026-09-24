/**
 * The bounded, ordered event stream of one session (runtime R2).
 *
 * Every event gets the next `seq` (strictly increasing from 1). The log keeps the most recent
 * `capacity` events, so a client that reconnects can resume from its last seen `seq` (SSE
 * Last-Event-ID). A client that fell further behind than the log reaches receives a `resync`
 * event (with how many it missed) before the retained events: nothing is silently skipped, and
 * memory is bounded whatever the client does.
 */
import type { SessionEvent } from './protocol.js';

type Body = SessionEvent extends infer E ? (E extends unknown ? Omit<E, 'seq'> : never) : never;

export class EventLog {
  private readonly events: SessionEvent[] = [];
  private nextSeq = 1;
  private readonly listeners = new Set<(e: SessionEvent) => void>();

  constructor(private readonly capacity: number) {}

  append(body: Body): SessionEvent {
    const e = { ...body, seq: this.nextSeq++ } as SessionEvent;
    this.events.push(e);
    if (this.events.length > this.capacity) this.events.shift();
    for (const l of this.listeners) l(e);
    return e;
  }

  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  /** Events after `afterSeq`, preceded by a resync marker if some were already dropped. */
  since(afterSeq: number): SessionEvent[] {
    const first = this.events[0]?.seq ?? this.nextSeq;
    const out: SessionEvent[] = [];
    if (afterSeq + 1 < first) {
      out.push({ seq: first - 1, simNs: null, type: 'resync', missed: first - 1 - afterSeq });
    }
    for (const e of this.events) if (e.seq > afterSeq) out.push(e);
    return out;
  }

  subscribe(listener: (e: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get size(): number {
    return this.events.length;
  }
}

/**
 * Debounced local-first autosave with save-state reporting.
 *
 * Promoted from experiments/gate-d-persistence/src/autosave.ts. Added: a save state the UI
 * can show ("All changes saved" / "Saving…" / "Could not save"), and failure handling that
 * never drops the in-memory document: a failed write keeps the latest document pending and
 * is retried on the next change or on an explicit `retry()`.
 */

import type { ProjectDocument } from '@tbi-lab/domain';
import { isQuotaError, type ProjectStorage } from './store.js';

/** Injectable timer so unit tests can drive the debounce deterministically. */
export type ScheduleFn = (handler: () => void, delayMs: number) => unknown;
export type CancelFn = (handle: unknown) => void;

export type SaveState = 'saved' | 'saving' | 'error';

export interface AutosaveOptions {
  debounceMs?: number;
  schedule?: ScheduleFn;
  cancel?: CancelFn;
}

export class Autosave {
  private timer: unknown = null;
  private pending: ProjectDocument | null = null;
  private inFlight: Promise<void> = Promise.resolve();
  private readonly debounceMs: number;
  private readonly schedule: ScheduleFn;
  private readonly cancel: CancelFn;
  private listeners = new Set<(s: SaveState) => void>();
  private stateValue: SaveState = 'saved';
  /** Why the last write failed, so the UI can say something specific. */
  lastError: 'quota' | 'write' | null = null;

  /** Number of physical writes performed, so tests can assert debouncing actually happened. */
  writeCount = 0;

  constructor(
    private readonly store: ProjectStorage,
    options: AutosaveOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 300;
    // setTimeout must keep its global receiver in browsers; calling a stored bare reference
    // as a method throws "Illegal invocation" (the Gate D defect, fixed there and here).
    this.schedule = options.schedule ?? ((handler, delayMs) => setTimeout(handler, delayMs));
    this.cancel =
      options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get state(): SaveState {
    return this.stateValue;
  }

  /** True while a change exists that is not yet confirmed on disk. */
  get dirty(): boolean {
    return this.pending !== null || this.stateValue !== 'saved';
  }

  onState(listener: (s: SaveState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setState(s: SaveState): void {
    if (s === this.stateValue) return;
    this.stateValue = s;
    for (const l of this.listeners) l(s);
  }

  /** Queue a save. Returns immediately: editing is never blocked by persistence. */
  queue(doc: ProjectDocument): void {
    this.pending = doc;
    this.setState('saving');
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = this.schedule(() => void this.flush(), this.debounceMs);
  }

  /**
   * Drop any queued, not-yet-written change of `projectId` and wait until no write is in
   * flight. Used before deleting a project, so that a pending autosave cannot write the
   * deleted project back afterwards.
   */
  async discard(projectId: string): Promise<void> {
    if (this.pending?.projectId === projectId) {
      if (this.timer !== null) {
        this.cancel(this.timer);
        this.timer = null;
      }
      this.pending = null;
    }
    await this.inFlight;
    if (!this.pending) this.setState('saved');
  }

  /** Re-attempt after a failure. */
  retry(): Promise<void> {
    return this.flush();
  }

  /** Force any queued document to disk and wait for it. Never rejects. */
  flush(): Promise<void> {
    if (this.timer !== null) {
      this.cancel(this.timer);
      this.timer = null;
    }
    const doc = this.pending;
    if (!doc) return this.inFlight;
    this.pending = null;
    this.inFlight = this.inFlight.then(async () => {
      this.setState('saving');
      try {
        await this.store.save(doc);
        this.writeCount++;
        this.lastError = null;
        // A newer change may have been queued while this write was in flight.
        this.setState(this.pending ? 'saving' : 'saved');
      } catch (e) {
        // Keep the newest document: a later queue() replaces it, retry() re-attempts it.
        this.pending ??= doc;
        this.lastError = isQuotaError(e) ? 'quota' : 'write';
        this.setState('error');
      }
    });
    return this.inFlight;
  }
}

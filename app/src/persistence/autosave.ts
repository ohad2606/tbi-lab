/**
 * Debounced local-first autosave with save-state reporting.
 *
 * Promoted from experiments/gate-d-persistence/src/autosave.ts. Added: a save state the UI
 * can show ("All changes saved" / "Saving…" / "Could not save"), and failure handling that
 * never drops the in-memory document: a failed write keeps the latest document pending and
 * is retried on the next change or on an explicit `retry()`.
 */

import type { ProjectDocument } from '@tbi-lab/domain';
import {
  ProjectConflictError,
  isQuotaError,
  versionOf,
  type ProjectStorage,
  type StoredVersion,
} from './store.js';

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
  /**
   * Documents not yet confirmed on disk, ONE PER PROJECT (Sprint 13 Task D): a single slot for all
   * projects let the first change to project B silently replace project A's failed write.
   */
  private readonly pending = new Map<string, ProjectDocument>();
  private inFlight: Promise<void> = Promise.resolve();
  private readonly debounceMs: number;
  private readonly schedule: ScheduleFn;
  private readonly cancel: CancelFn;
  private listeners = new Set<(s: SaveState) => void>();
  private stateValue: SaveState = 'saved';
  /**
   * Why the last write failed, so the UI can say something specific. `conflict`: another tab or
   * window changed or deleted the project; this tab's version was NOT written (Sprint 13 Task D).
   */
  lastError: 'quota' | 'write' | 'conflict' | null = null;
  /** The stored version each project is known to be at (what this tab opened or last wrote). */
  private readonly known = new Map<string, StoredVersion>();

  /** The project as it is stored now (just opened, created or imported in this tab). */
  know(doc: Pick<ProjectDocument, 'projectId' | 'revision'>): void {
    this.known.set(doc.projectId, versionOf(doc));
  }

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
    return this.pending.size > 0 || this.stateValue !== 'saved';
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
    this.pending.set(doc.projectId, doc);
    this.setState('saving');
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = this.schedule(() => void this.flush(), this.debounceMs);
  }

  /**
   * Drop any queued, not-yet-written change of `projectId` and wait until no write is in
   * flight. Used before deleting a project, so that a pending autosave cannot write the
   * deleted project back afterwards.
   */
  async discard(projectId: string): Promise<ProjectDocument | null> {
    const dropped = this.pending.get(projectId) ?? null;
    if (this.pending.delete(projectId) && this.pending.size === 0 && this.timer !== null) {
      this.cancel(this.timer);
      this.timer = null;
    }
    await this.inFlight;
    if (this.pending.size === 0 && this.lastError === null) this.setState('saved');
    // The dropped document, so a caller whose delete then fails can queue it again (Task D, M2).
    return dropped;
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
    if (this.pending.size === 0) return this.inFlight;
    const docs = [...this.pending.values()];
    this.pending.clear();
    this.inFlight = this.inFlight.then(async () => {
      this.setState('saving');
      let failed: unknown = null;
      for (const doc of docs) {
        try {
          await this.store.save(doc, this.known.get(doc.projectId));
          this.known.set(doc.projectId, versionOf(doc));
          this.writeCount++;
        } catch (e) {
          // Keep the newest document of THIS project: a later queue() of the same project
          // replaces it, retry() or the next flush re-attempts it; other projects are unaffected.
          if (!this.pending.has(doc.projectId)) this.pending.set(doc.projectId, doc);
          failed ??= e;
        }
      }
      if (failed !== null) {
        this.lastError =
          failed instanceof ProjectConflictError
            ? 'conflict'
            : isQuotaError(failed)
              ? 'quota'
              : 'write';
        this.setState('error');
        return;
      }
      this.lastError = null;
      // A newer change may have been queued while these writes were in flight.
      this.setState(this.pending.size > 0 ? 'saving' : 'saved');
    });
    return this.inFlight;
  }
}

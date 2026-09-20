/**
 * Debounced local-first autosave.
 *
 * The ordering Gate D demonstrates is: local write -> user carries on immediately ->
 * (later, out of scope) background cloud sync. Nothing here blocks on a network.
 */

import type { ProjectState } from './projectState.js';
import type { ProjectStore } from './store.js';

/** Injectable timer so unit tests can drive the debounce deterministically. */
export type ScheduleFn = (handler: () => void, delayMs: number) => ReturnType<typeof setTimeout>;

export interface AutosaveOptions {
  debounceMs?: number;
  schedule?: ScheduleFn;
}

export class Autosave {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: ProjectState | null = null;
  private inFlight: Promise<void> = Promise.resolve();
  private readonly debounceMs: number;
  private readonly schedule: ScheduleFn;

  /** Number of physical writes performed, so tests can assert debouncing actually happened. */
  writeCount = 0;

  constructor(private readonly store: ProjectStore, options: AutosaveOptions = {}) {
    this.debounceMs = options.debounceMs ?? 50;
    // NOTE: setTimeout must keep its global receiver in browsers; storing the bare function
    // reference and calling it as a method throws "Illegal invocation".
    this.schedule = options.schedule ?? ((handler, delayMs) => setTimeout(handler, delayMs));
  }

  /** Queue a save. Returns immediately: editing is never blocked by persistence. */
  queue(state: ProjectState): void {
    this.pending = state;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = this.schedule(() => void this.flush(), this.debounceMs);
  }

  /** Force any queued state to disk and wait for it. */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const state = this.pending;
    this.pending = null;
    if (!state) return this.inFlight;
    this.inFlight = this.inFlight.then(async () => {
      await this.store.save(state);
      this.writeCount++;
    });
    return this.inFlight;
  }
}

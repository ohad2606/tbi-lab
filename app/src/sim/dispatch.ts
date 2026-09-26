/**
 * Simulation dispatch (Sprint 6): one Run control, two hosts.
 *
 *   project has no MCU            -> the browser-local Worker engine (unchanged: offline,
 *                                    local-first, no network involved)
 *   project has a Classic ESP32   -> an ephemeral R2 Session Host session
 *
 * The rule is decided at every Run from the project being run, never from a setting; ordinary
 * DC projects never touch the network. Only one host is active at a time: running with one
 * stops the other.
 */
import type { LiveControl } from '@tbi-lab/engine';
import type { ProjectDocument } from '@tbi-lab/domain';
import { requiresMcuRuntime } from '../runtime/snapshot.js';
import type { SimState, SimulationHost } from './controller.js';

export class SimulationDispatcher implements SimulationHost {
  private current: SimulationHost;
  private listeners = new Set<() => void>();

  constructor(
    private readonly local: SimulationHost,
    private readonly mcu: SimulationHost,
  ) {
    this.current = local;
    const forward = (host: SimulationHost) => () => {
      if (host === this.current) for (const l of this.listeners) l();
    };
    local.subscribe(forward(local));
    mcu.subscribe(forward(mcu));
  }

  /** Which host ran (or will run) the current project: for tests and diagnostics. */
  get engine(): 'local' | 'mcu' {
    return this.current === this.mcu ? 'mcu' : 'local';
  }

  get state(): SimState {
    return this.current.state;
  }

  get active(): boolean {
    return this.current.active;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async run(doc: ProjectDocument): Promise<void> {
    const next = requiresMcuRuntime(doc) ? this.mcu : this.local;
    if (next !== this.current) {
      this.current.stop();
      this.current = next;
    }
    await next.run(doc);
  }

  control(component: string, control: LiveControl, projectRevision: number): boolean {
    return this.current.control(component, control, projectRevision);
  }

  momentary(component: string, pressed: boolean): boolean {
    return this.current.momentary(component, pressed);
  }

  stop(): void {
    this.current.stop();
  }

  dispose(): void {
    this.local.dispose();
    this.mcu.dispose();
  }
}

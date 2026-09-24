/**
 * Ordered runtime commands in SIMULATION time (ADR-007). A schedule is validated before a session
 * starts, and a command can never be applied in the past: an ordering error fails closed
 * (`CommandOrderError`) instead of being reordered or applied late.
 */

export class CommandOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandOrderError';
  }
}

export interface Scheduled<T> {
  atNs: bigint;
  command: T;
}

export class CommandSchedule<T> {
  private readonly queue: Scheduled<T>[];
  private next = 0;
  private lastTickNs = -1n;

  constructor(commands: readonly Scheduled<T>[]) {
    for (let i = 0; i < commands.length; i++) {
      const c = commands[i]!;
      if (c.atNs < 0n) throw new CommandOrderError(`command ${i} is scheduled before time 0`);
      if (i > 0 && c.atNs < commands[i - 1]!.atNs) {
        throw new CommandOrderError(
          `command ${i} (${c.atNs} ns) is scheduled before command ${i - 1} (${commands[i - 1]!.atNs} ns)`,
        );
      }
    }
    this.queue = [...commands];
  }

  /** Commands due at the tick `vns` (at or before it), in order. Ticks must advance. */
  due(vns: bigint): Scheduled<T>[] {
    if (vns <= this.lastTickNs) throw new CommandOrderError(`tick ${vns} does not advance`);
    this.lastTickNs = vns;
    const out: Scheduled<T>[] = [];
    while (this.next < this.queue.length && this.queue[this.next]!.atNs <= vns) {
      out.push(this.queue[this.next++]!);
    }
    return out;
  }

  /** Add a command while running. It may not be earlier than the last applied tick. */
  add(c: Scheduled<T>): void {
    if (c.atNs <= this.lastTickNs) {
      throw new CommandOrderError(
        `command at ${c.atNs} ns is in the past (now ${this.lastTickNs} ns)`,
      );
    }
    const tail = this.queue[this.queue.length - 1];
    if (tail && c.atNs < tail.atNs) {
      throw new CommandOrderError(`command at ${c.atNs} ns is before the last scheduled command`);
    }
    this.queue.push(c);
  }

  get applied(): number {
    return this.next;
  }
}

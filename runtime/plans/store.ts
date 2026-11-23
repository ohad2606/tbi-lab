/**
 * TBI-018 slice 1: persistence. `Store` is an append-only event log. `MemoryStore` for tests and
 * `JournalStore`: JSONL, one line per event with a per-line checksum, fsync'd on every append.
 * A torn tail (partial last line) or a corrupt line is REPORTED by load(); it is never silently skipped.
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  truncateSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { PlanEvent } from './events.js';

export type StoreProblem =
  { kind: 'torn_tail'; detail: string; validBytes: number } | { kind: 'corrupt'; detail: string };

export interface LoadResult<E = PlanEvent> {
  events: E[];
  problem?: StoreProblem;
}

/** Generic over the event type so each service journal (credits/spend, sim minutes) has its own log. */
export interface Store<E = PlanEvent> {
  append(events: E[]): Promise<void>;
  load(): Promise<LoadResult<E>>;
  /** Explicit recovery: drop a torn tail. Corruption in the middle is never repaired. */
  recoverTornTail?(): Promise<void>;
  /**
   * Compaction: replace the WHOLE journal by `events`, atomically (after a crash the journal is either
   * the old one or the new one, never a mix). Optional: a store without it cannot be compacted.
   */
  replace?(events: E[]): Promise<void>;
}

export class MemoryStore<E = PlanEvent> implements Store<E> {
  events: E[] = [];
  appendCalls = 0;
  /** test hook: throw on append call number n (1-based), or on every call when `always` */
  failOnCall: number | 'always' | null = null;
  /** test hook: replace() throws and leaves the events unchanged */
  failReplace = false;
  async append(events: E[]): Promise<void> {
    this.appendCalls += 1;
    if (this.failOnCall === 'always' || this.failOnCall === this.appendCalls)
      throw new Error('store append failed (test hook)');
    this.events.push(...structuredClone(events));
  }
  async load(): Promise<LoadResult<E>> {
    return { events: structuredClone(this.events) };
  }
  async replace(events: E[]): Promise<void> {
    if (this.failReplace) throw new Error('store replace failed (test hook)');
    this.events = structuredClone(events);
  }
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);
export const encodeLine = (e: unknown): string => {
  const json = JSON.stringify(e);
  return `${sha(json)}\t${json}\n`;
};

export class JournalStore<E = PlanEvent> implements Store<E> {
  constructor(private readonly path: string) {}

  async append(events: E[]): Promise<void> {
    if (events.length === 0) return;
    const data = Buffer.from(events.map(encodeLine).join(''), 'utf8');
    const fd = openSync(this.path, 'a', 0o600);
    try {
      let off = 0;
      while (off < data.length) off += writeSync(fd, data, off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  async load(): Promise<LoadResult<E>> {
    if (!existsSync(this.path)) return { events: [] };
    const buf = readFileSync(this.path);
    const events: E[] = [];
    let pos = 0;
    while (pos < buf.length) {
      const nl = buf.indexOf(0x0a, pos);
      if (nl === -1)
        return {
          events,
          problem: { kind: 'torn_tail', detail: 'last record has no newline', validBytes: pos },
        };
      const line = buf.subarray(pos, nl).toString('utf8');
      const tab = line.indexOf('\t');
      const json = tab === -1 ? '' : line.slice(tab + 1);
      if (tab === -1 || sha(json) !== line.slice(0, tab)) {
        const last = nl + 1 >= buf.length;
        return {
          events,
          problem: last
            ? { kind: 'torn_tail', detail: 'last record fails its checksum', validBytes: pos }
            : { kind: 'corrupt', detail: `record at byte ${pos} fails its checksum` },
        };
      }
      try {
        events.push(JSON.parse(json) as E);
      } catch {
        return {
          events,
          problem: { kind: 'corrupt', detail: `record at byte ${pos} is not JSON` },
        };
      }
      pos = nl + 1;
    }
    return { events };
  }

  /** Write a temp file, fsync it, rename it over the journal, fsync the directory. */
  async replace(events: E[]): Promise<void> {
    const tmp = `${this.path}.compact-tmp`;
    const data = Buffer.from(events.map(encodeLine).join(''), 'utf8');
    // never follow a planted file or symlink: remove whatever is there, then create exclusively
    try {
      unlinkSync(tmp);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      let off = 0;
      while (off < data.length) off += writeSync(fd, data, off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
    const dfd = openSync(dirname(this.path), 'r');
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  }

  async recoverTornTail(): Promise<void> {
    const r = await this.load();
    if (r.problem?.kind !== 'torn_tail') return;
    truncateSync(this.path, r.problem.validBytes);
    const fd = openSync(this.path, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

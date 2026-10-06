/**
 * Program build state (Sprint 7): ephemeral, per open program, never project data.
 *
 * The relationship "this artifact is the build of that source" is a content key: a build result
 * is CURRENT only while its source key equals the key of the program's current text. Any edit
 * changes the key, so the previous build becomes stale at once and can never be run for the
 * edited source (D-S7-4). Nothing builds automatically: Build is an explicit action, refused while
 * an ESP32 session is running (D-S7-9). After a reload the state is recovered by a lookup (an
 * existing build of exactly this source), never by building.
 */
import { sourceKey, type ProgramSource } from '@tbi-lab/domain';
import { BuildTransportError, type BuildClient, type BuildResult } from './client.js';

export type BuildPhase =
  /** No build of the current source (never built, or edited since): Build required. */
  | 'required'
  /** Build of the current source in progress (queued or compiling). */
  | 'building'
  /** A successful build of exactly the current source: Run uses it. */
  | 'current'
  /** The last build of the current source failed (diagnostics). */
  | 'failed';

export interface BuildView {
  phase: BuildPhase;
  /** The result for the current source (current or failed). */
  result?: BuildResult;
  /** A result for an earlier version of the source (stale), kept for its diagnostics only. */
  previous?: BuildResult;
  /** Queue position while waiting. */
  position?: number;
  /** Why the service could not be used (transport), when the last attempt failed that way. */
  error?: BuildTransportError['code'];
}

/**
 * Identity of a program's input without hashing it: the exact text and its profile/file name.
 * Matching a build to the current source compares these directly (a native string comparison),
 * so typing never hashes the whole sketch; the content key is computed only to build or look up.
 */
interface Input {
  profile: string;
  fileName: string;
  text: string;
}
const same = (a: Input | undefined, b: ProgramSource) =>
  !!a && a.text === b.text && a.profile === b.profile && a.fileName === b.fileName;
const inputOf = (p: ProgramSource): Input => ({
  profile: p.profile,
  fileName: p.fileName,
  text: p.text,
});

interface Entry {
  result?: BuildResult;
  /** The input `result` was built from. */
  resultInput?: Input;
  building?: { input: Input; position?: number };
  error?: { input: Input; code: BuildTransportError['code'] };
}

const MAX_ENTRIES = 8;

/**
 * The source key of a program. Memoised on the exact inputs: the editor asks for it on every
 * render, and hashing a large sketch per keystroke is measurable (Sprint 7 measurement).
 */
const keyCache = new Map<string, string>();
export function programKey(program: ProgramSource): string {
  const id = `${program.profile}\u0000${program.fileName}\u0000${program.text}`;
  let key = keyCache.get(id);
  if (key === undefined) {
    key = sourceKey(program.profile, [{ name: program.fileName, text: program.text }]);
    keyCache.set(id, key);
    while (keyCache.size > 8) keyCache.delete(keyCache.keys().next().value!);
  }
  return key;
}

export class ProgramBuilds {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  /** Bumped on every change (cheap memo key for the UI). */
  version = 0;

  constructor(
    private readonly deps: {
      client: BuildClient | null;
      /** True while an ESP32 session exists: Build is not allowed (D-S7-9). */
      sessionActive: () => boolean;
    },
  ) {}

  get available(): boolean {
    return this.deps.client !== null;
  }

  /** Whether any build is queued or compiling (a reload would abandon it). */
  get busy(): boolean {
    for (const e of this.entries.values()) if (e.building) return true;
    return false;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed() {
    this.version++;
    for (const l of this.listeners) l();
  }

  private entry(projectId: string, boardId: string): Entry {
    const id = `${projectId}/${boardId}`;
    let e = this.entries.get(id);
    if (!e) {
      e = {};
      this.entries.set(id, e);
      while (this.entries.size > MAX_ENTRIES)
        this.entries.delete(this.entries.keys().next().value!);
    }
    return e;
  }

  view(projectId: string, boardId: string, program: ProgramSource): BuildView {
    const e = this.entries.get(`${projectId}/${boardId}`) ?? {};
    if (e.building && same(e.building.input, program))
      return {
        phase: 'building',
        ...(e.building.position !== undefined ? { position: e.building.position } : {}),
      };
    if (e.result && same(e.resultInput, program))
      return { phase: e.result.ok ? 'current' : 'failed', result: e.result };
    return {
      phase: 'required',
      ...(e.result ? { previous: e.result } : {}),
      ...(e.error && same(e.error.input, program) ? { error: e.error.code } : {}),
    };
  }

  /** The successful build of exactly this source, if any (what Run may use). */
  current(projectId: string, boardId: string, program: ProgramSource): BuildResult | null {
    const v = this.view(projectId, boardId, program);
    return v.phase === 'current' ? v.result! : null;
  }

  /** Explicit Build. Returns false (and does nothing) while an ESP32 session is running. */
  async build(projectId: string, boardId: string, program: ProgramSource): Promise<boolean> {
    const client = this.deps.client;
    if (!client || this.deps.sessionActive()) return false;
    const input = inputOf(program);
    const e = this.entry(projectId, boardId);
    if (e.building) return false; // one build per program at a time
    e.building = { input };
    delete e.error;
    this.changed();
    try {
      const result = await client.build(
        program.profile,
        [{ name: program.fileName, text: program.text }],
        (state, position) => {
          if (e.building?.input !== input) return;
          e.building = {
            input,
            ...(state === 'queued' && position !== undefined ? { position } : {}),
          };
          this.changed();
        },
      );
      e.result = result;
      e.resultInput = input;
    } catch (err) {
      e.error = { input, code: err instanceof BuildTransportError ? err.code : 'unreachable' };
    } finally {
      delete e.building;
      this.changed();
    }
    return true;
  }

  /** After opening a project: recover an existing build of the current source (never builds). */
  async lookup(projectId: string, boardId: string, program: ProgramSource): Promise<void> {
    const client = this.deps.client;
    if (!client) return;
    const e = this.entry(projectId, boardId);
    if (same(e.resultInput, program) || e.building) return;
    const input = inputOf(program);
    const key = programKey(program);
    try {
      const found = await client.lookup(key);
      if (found && found.key === key && !e.building) {
        e.result = found;
        e.resultInput = input;
        this.changed();
      }
    } catch {
      // The lookup is a convenience: without it the state simply stays "Build required".
    }
  }

  /**
   * An artifact vanished from the service (evicted): forget the build so the program shows
   * "Build required" again. The source is untouched; nothing of the project is lost.
   */
  forget(projectId: string, boardId: string, sha256: string): void {
    const e = this.entries.get(`${projectId}/${boardId}`);
    if (e?.result?.artifact?.sha256 === sha256) {
      delete e.result;
      delete e.resultInput;
      this.changed();
    }
  }
}

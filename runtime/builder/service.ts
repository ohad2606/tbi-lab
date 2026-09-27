/**
 * Build service core (Sprint 7): one compilation at a time, a short queue, a hard timeout, a
 * temporary-storage watchdog, guaranteed cleanup, a cache by source key, and short-lived build
 * records. Providers do the toolchain work; this module owns every limit (D-S7-8).
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { sourceKey } from '@tbi-lab/domain';
import {
  RequestError,
  type BuildRequest,
  type BuildResult,
  type BuildState,
  type BuildStatus,
} from './protocol.js';
import type { BuildProvider, ProviderOutput } from './provider.js';
import type { ArtifactStore } from './store.js';

export interface ServiceLimits {
  /** Builds waiting behind the active one (D-S7-8: 3). */
  maxQueued: number;
  /** Hard compilation timeout (D-S7-8: 240 s). */
  timeoutMs: number;
  /** Temporary storage per build (D-S7-8: 512 MiB). */
  maxTempBytes: number;
  /** Watchdog period for the temporary-storage check. */
  watchdogMs: number;
  /** Finished build records are kept this long (status polling, lookup). */
  recordTtlMs: number;
  maxRecords: number;
}

export const DEFAULT_LIMITS: ServiceLimits = {
  maxQueued: 3,
  timeoutMs: 240_000,
  maxTempBytes: 512 * 1024 * 1024,
  watchdogMs: 2_000,
  recordTtlMs: 24 * 60 * 60 * 1000,
  maxRecords: 500,
};

interface BuildRecord {
  id: string;
  token: string;
  key: string;
  request: BuildRequest;
  provider: BuildProvider;
  state: BuildState;
  result?: BuildResult;
  submittedAt: number;
  finishedAt?: number;
}

export class BuildService {
  private readonly providers = new Map<string, BuildProvider>();
  private readonly records = new Map<string, BuildRecord>();
  private readonly queue: BuildRecord[] = [];
  private active: BuildRecord | null = null;
  private readonly idle = new Set<() => void>();

  constructor(
    providers: BuildProvider[],
    readonly store: ArtifactStore,
    private readonly workRoot: string,
    readonly limits: ServiceLimits = DEFAULT_LIMITS,
  ) {
    for (const p of providers) this.providers.set(p.profile.id, p);
  }

  /** Remove job directories left behind by a previous process (crash, kill). */
  async sweep(): Promise<void> {
    for (const name of await readdir(this.workRoot))
      if (name.startsWith('job-'))
        await rm(join(this.workRoot, name), { recursive: true, force: true });
  }

  profiles(): string[] {
    return [...this.providers.keys()];
  }

  /**
   * Submit a build. A finished successful build of the same input is returned at once (cache
   * hit, no compilation); an identical build already queued or running is shared.
   */
  submit(request: BuildRequest): { cached: BuildResult } | { buildId: string; token: string } {
    const provider = this.providers.get(request.profile);
    if (!provider) throw new RequestError(400, 'unknown_profile');
    const key = sourceKey(request.profile, request.files);
    const hit = this.cachedResult(key);
    if (hit) return { cached: hit };
    const pending = [...this.queue, ...(this.active ? [this.active] : [])].find(
      (r) => r.key === key,
    );
    if (pending) return { buildId: pending.id, token: pending.token };
    if (this.queue.length >= this.limits.maxQueued) throw new RequestError(429, 'busy');
    this.prune();
    const record: BuildRecord = {
      id: `b_${randomBytes(12).toString('hex')}`,
      token: randomBytes(24).toString('base64url'),
      key,
      request,
      provider,
      state: 'queued',
      submittedAt: Date.now(),
    };
    this.records.set(record.id, record);
    this.queue.push(record);
    void this.pump();
    return { buildId: record.id, token: record.token };
  }

  /** Status of a build; a wrong token is indistinguishable from an unknown id. */
  status(id: string, token: string): BuildStatus | null {
    const r = this.records.get(id);
    if (!r || r.token !== token) return null;
    const position = r.state === 'queued' ? this.queue.indexOf(r) : undefined;
    return {
      buildId: r.id,
      state: r.state,
      ...(position !== undefined && position >= 0 ? { position } : {}),
      ...(r.result ? { result: r.result } : {}),
    };
  }

  /** The successful build of a source key, if its artifact still exists. Never builds. */
  lookup(key: string): BuildResult | null {
    return this.cachedResult(key);
  }

  /** Resolves when no build is active or queued (tests, shutdown). */
  whenIdle(): Promise<void> {
    if (!this.active && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idle.add(resolve));
  }

  private cachedResult(key: string): BuildResult | null {
    const found = this.store.findBuild(key);
    if (!found) return null;
    return { ...found, timings: { queuedMs: 0, buildMs: 0 } };
  }

  private prune() {
    const now = Date.now();
    const finished = [...this.records.values()].filter((r) => r.finishedAt !== undefined);
    for (const r of finished)
      if (now - r.finishedAt! > this.limits.recordTtlMs) this.records.delete(r.id);
    const overflow = this.records.size - this.limits.maxRecords;
    if (overflow > 0)
      finished
        .sort((a, b) => a.finishedAt! - b.finishedAt!)
        .slice(0, overflow)
        .forEach((r) => this.records.delete(r.id));
  }

  private async pump(): Promise<void> {
    if (this.active) return;
    const next = this.queue.shift();
    if (!next) {
      for (const done of this.idle) done();
      this.idle.clear();
      return;
    }
    this.active = next;
    next.state = 'building';
    try {
      next.result = await this.run(next);
    } catch {
      next.result = this.failed(next, 'internal', 'Build service: internal error.', 0);
    }
    next.state = next.result.ok ? 'succeeded' : 'failed';
    next.finishedAt = Date.now();
    this.active = null;
    void this.pump();
  }

  private failed(
    r: BuildRecord,
    failure: BuildResult['failure'],
    message: string,
    buildMs: number,
  ) {
    return {
      key: r.key,
      profile: r.request.profile,
      profileHash: r.provider.profileHash,
      ok: false,
      failure,
      diagnostics: [{ severity: 'error' as const, message }],
      log: { text: '', truncated: false },
      timings: { queuedMs: Date.now() - r.submittedAt - buildMs, buildMs },
    } satisfies BuildResult;
  }

  private async run(r: BuildRecord): Promise<BuildResult> {
    const started = Date.now();
    const queuedMs = started - r.submittedAt;
    const dir = await mkdtemp(join(this.workRoot, 'job-'));
    const abort = new AbortController();
    let reason: 'timeout' | 'storage_limit' | null = null;
    const timer = setTimeout(() => {
      reason = 'timeout';
      abort.abort();
    }, this.limits.timeoutMs);
    const watchdog = setInterval(() => {
      void treeBytes(dir).then((bytes) => {
        if (bytes > this.limits.maxTempBytes && !abort.signal.aborted) {
          reason = 'storage_limit';
          abort.abort();
        }
      });
    }, this.limits.watchdogMs);
    let out: ProviderOutput;
    try {
      out = await r.provider.build({ dir, files: r.request.files, signal: abort.signal });
      if (!abort.signal.aborted && out.ok && out.imagePath) {
        const base: Omit<BuildResult, 'timings' | 'artifact'> = {
          key: r.key,
          profile: r.request.profile,
          profileHash: r.provider.profileHash,
          ok: true,
          ...(out.features ? { features: out.features } : {}),
          ...(out.sizes ? { sizes: out.sizes } : {}),
          diagnostics: out.diagnostics,
          log: out.log,
        };
        const artifact = await this.store.publishFile(out.imagePath, (info) => ({
          origin: 'build',
          key: r.key,
          result: { ...base, artifact: info },
        }));
        const result: BuildResult = {
          ...base,
          artifact,
          timings: { queuedMs, buildMs: Date.now() - started },
        };
        return result;
      }
    } finally {
      clearTimeout(timer);
      clearInterval(watchdog);
      await rm(dir, { recursive: true, force: true });
    }
    const buildMs = Date.now() - started;
    if (reason === 'timeout')
      return this.failed(
        r,
        'timeout',
        `The build took longer than ${this.limits.timeoutMs / 1000} s and was stopped.`,
        buildMs,
      );
    if (reason === 'storage_limit')
      return this.failed(
        r,
        'storage_limit',
        'The build used too much temporary storage and was stopped.',
        buildMs,
      );
    return {
      key: r.key,
      profile: r.request.profile,
      profileHash: r.provider.profileHash,
      ok: false,
      failure: out!.failure ?? 'compile_error',
      diagnostics: out!.diagnostics,
      log: out!.log,
      timings: { queuedMs, buildMs },
    };
  }
}

/** Total size of a directory tree (bytes); symlinks are not followed. */
export async function treeBytes(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let names: string[];
    try {
      names = await readdir(d);
    } catch {
      continue;
    }
    for (const n of names) {
      const p = join(d, n);
      try {
        const st = await lstat(p);
        if (st.isDirectory()) stack.push(p);
        else total += st.size;
      } catch {
        // removed meanwhile
      }
    }
  }
  return total;
}

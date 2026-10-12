/**
 * Build service core (Sprint 7): one compilation at a time, a short queue, a hard timeout, a
 * temporary-storage watchdog, guaranteed cleanup, a cache by source key, and short-lived build
 * records. Providers do the toolchain work; this module owns every limit (D-S7-8).
 *
 * Sprint 8 (D-S8-2/3/4): every call names its principal. Cache hits, lookups, build status and
 * leases see only the caller's own grants plus the shared system records (curated sources, R1
 * reference images); an identical private source of another user is compiled again (the bytes
 * are still stored once). A lease issues a run ticket for the Session Host.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { sourceKey } from '@tbi-lab/domain';
import {
  RequestError,
  type BuildRequest,
  type BuildResult,
  type BuildState,
  type BuildStatus,
} from './protocol.js';
import type { Principal } from '../identity/principal.js';
import { signTicket, type TicketFeatures } from '../identity/ticket.js';
import { GLOBAL, type Grants, type Owner } from './grants.js';
import type { BuildProvider, ProviderOutput } from './provider.js';
import type { ArtifactStore } from './store.js';
import type { Policy } from '../policy/policy.js';
import type { RateLimiter } from '../policy/rate.js';
import { Refusal, admissionEvent } from '../policy/refusal.js';
import { checkResources, type ResourceProbe } from '../policy/resources.js';

/** Ownership, authorization and policy (Sprint 8). */
export interface ServiceAccess {
  grants: Grants;
  /** Key shared with the Session Host for run tickets. */
  ticketKey: Buffer;
  /** Source keys of the curated system sources: their builds are shared (`global`). */
  systemKeys: ReadonlySet<string>;
  /** Plans, quotas and global limits (Phase 4). */
  policy: Policy;
  /** Persistent per-principal rate windows (submissions, failures, uploads). */
  rates: RateLimiter;
  /** Host resources (disk, memory); tests substitute. */
  probe?: ResourceProbe;
  /**
   * Live runtime sessions on this host right now (the Session Host's health). New builds do not
   * START while sessions use the CPUs (policy). `null` = unknown (health stale or unreachable):
   * fail closed — no new build starts until a fresh reading shows free CPUs. Absent = no runtime
   * on this host (development, unit tests): builds are never deferred.
   */
  liveSessions?: () => number | null;
}

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
  /** Who the build belongs to: the submitter, or `global` for a curated system source. */
  owner: Owner;
  /** Who asked for it: their quota and limits apply (also for a shared system source). */
  submitter: Principal;
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
  /** Builds compiling now (at most the policy's `maxActiveBuilds`). */
  private readonly active = new Set<BuildRecord>();
  private readonly idle = new Set<() => void>();

  constructor(
    providers: BuildProvider[],
    readonly store: ArtifactStore,
    private readonly workRoot: string,
    readonly limits: ServiceLimits,
    readonly access: ServiceAccess,
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
  submit(
    request: BuildRequest,
    principal: Principal,
  ): { cached: BuildResult } | { buildId: string; token: string } {
    const provider = this.providers.get(request.profile);
    if (!provider) throw new RequestError(400, 'unknown_profile');
    // Sprint 13 security audit (#4): refuse an over-size source BEFORE it is held in a build
    // record (records live up to a day; the provider's own check came after the record).
    const bytes = request.files.reduce((n, f) => n + Buffer.byteLength(f.text, 'utf8'), 0);
    if (bytes > provider.profile.maxSourceBytes) throw new RequestError(413, 'source_too_large');
    const key = sourceKey(request.profile, request.files);
    const hit = this.cachedResult(principal, key);
    if (hit) return { cached: hit };
    const owner: Owner = this.access.systemKeys.has(key) ? GLOBAL : principal;
    // Only the same owner's pending build is shared: joining someone else's would reveal it.
    const pending = [...this.queue, ...this.active].find((r) => r.key === key && r.owner === owner);
    if (pending) return { buildId: pending.id, token: pending.token };
    this.admit(principal);
    this.prune();
    const record: BuildRecord = {
      id: `b_${randomBytes(12).toString('hex')}`,
      token: randomBytes(24).toString('base64url'),
      key,
      owner,
      submitter: principal,
      request,
      provider,
      state: 'queued',
      submittedAt: Date.now(),
    };
    this.records.set(record.id, record);
    this.queue.push(record);
    admissionEvent('build', 'submit', 'admitted', principal);
    this.pump();
    return { buildId: record.id, token: record.token };
  }

  /**
   * Admission of a NEW compilation (Phase 4), checked synchronously in one go so that concurrent
   * requests cannot race past a limit; the rate token is taken last, so a refused request never
   * consumes it. Order: the user's own limits, then shared capacity, then the user's rate.
   */
  private admit(principal: Principal): void {
    const plan = this.access.policy.plan(principal);
    const g = this.access.policy.config.global;
    const mine = (r: BuildRecord | null) => r?.submitter === principal;
    const inFlight = this.queue.filter(mine).length + [...this.active].filter(mine).length;
    if (inFlight >= plan.build.maxActive + plan.build.maxQueued) throw new Refusal('build_quota');
    const failures = this.access.rates.check(principal, 'build-failure', plan.build.failures);
    if (!failures.ok) {
      const last = this.access.rates.latest(principal, 'build-failure') ?? Date.now();
      const wait = last + plan.build.cooldownMs - Date.now();
      if (wait > 0) throw new Refusal('build_cooldown', wait);
    }
    this.checkStorage(principal);
    checkResources(g.resources, this.workRoot, this.access.probe);
    if (this.queue.length >= g.build.maxQueued) throw new Refusal('builder_busy', 30_000);
    const rate = this.access.rates.take(principal, 'build-submit', plan.build.submissions);
    if (!rate.ok) throw new Refusal('rate_limited', rate.retryAfterMs);
  }

  /**
   * A principal at their artifact quota can still build when their own least recently used,
   * unleased artifact can make room; otherwise `storage_quota`.
   */
  private checkStorage(principal: Principal): void {
    const s = this.access.policy.plan(principal).storage;
    const u = this.access.grants.usage(principal);
    if (u.artifacts < s.maxArtifacts && u.bytes < s.maxBytes) return;
    const evictable = this.access.grants
      .lruOf(principal)
      .some((a) => !this.store.isLeased(a.sha256));
    if (!evictable) throw new Refusal('storage_quota');
  }

  /**
   * Bring a principal back within their storage quota by dropping their own least recently used
   * grants (never a leased artifact, never someone else's); a blob is removed only when nobody
   * holds a grant on it any more.
   */
  private async enforceStorage(principal: Principal): Promise<void> {
    const s = this.access.policy.plan(principal).storage;
    for (const a of this.access.grants.lruOf(principal)) {
      const u = this.access.grants.usage(principal);
      if (u.artifacts <= s.maxArtifacts && u.bytes <= s.maxBytes) return;
      if (this.store.isLeased(a.sha256)) continue;
      this.access.grants.dropGrant(principal, a.sha256);
      if (this.access.grants.holders(a.sha256) === 0) await this.store.remove(a.sha256);
    }
  }

  /**
   * Retention (policy, not schema): private grants unused longer than their owner's plan allows
   * are dropped — never a leased artifact, never a shared system record; an artifact nobody holds
   * any more is removed. Returns how many grants were dropped.
   */
  async sweepRetention(now = Date.now()): Promise<number> {
    const policy = this.access.policy;
    let dropped = 0;
    for (const c of this.access.grants.unusedSince(now - policy.minRetentionMs)) {
      const days = policy.plan(c.owner).storage.retentionDays;
      if (c.lastUsedAt >= now - days * 24 * 3600_000 || this.store.isLeased(c.sha256)) continue;
      this.access.grants.dropGrant(c.owner, c.sha256);
      dropped++;
      if (this.access.grants.holders(c.sha256) === 0) await this.store.remove(c.sha256);
    }
    return dropped;
  }

  /**
   * Status of a build, for its owner only (a shared system build: anyone holding its token). A
   * wrong token or another owner is indistinguishable from an unknown id.
   */
  status(id: string, token: string, principal: Principal): BuildStatus | null {
    const r = this.records.get(id);
    // Constant-time token comparison (Sprint 13 audit #9; hashes give equal lengths).
    const same = (a: string, b: string) =>
      timingSafeEqual(
        createHash('sha256').update(a).digest(),
        createHash('sha256').update(b).digest(),
      );
    if (!r || !same(r.token, token) || (r.owner !== principal && r.owner !== GLOBAL)) return null;
    const position = r.state === 'queued' ? this.queue.indexOf(r) : undefined;
    return {
      buildId: r.id,
      state: r.state,
      ...(position !== undefined && position >= 0 ? { position } : {}),
      ...(r.result ? { result: r.result } : {}),
    };
  }

  /** The caller's successful build of a source key, if its artifact still exists. Never builds. */
  lookup(key: string, principal: Principal): BuildResult | null {
    return this.cachedResult(principal, key);
  }

  /**
   * Pin an artifact the principal may use and issue a run ticket for it; null (like "unknown")
   * when there is no grant — own, global, or an R1 reference image — or no blob.
   */
  lease(principal: Principal, sha: string, ms: number): { until: number; ticket: string } | null {
    const reference = this.store.isReference(sha);
    if (!reference && !this.access.grants.canUse(principal, sha)) return null;
    const until = this.store.lease(sha, ms);
    if (until === null) {
      this.access.grants.dropArtifact(sha);
      return null;
    }
    if (!reference) this.access.grants.touchFor(principal, sha);
    const f = reference ? null : this.access.grants.features(principal, sha);
    const features: TicketFeatures | null = f
      ? {
          internalPull: f.internalPull,
          gpioInterrupt: f.gpioInterrupt,
          restart: f.restart,
          unsupported: f.unsupported,
          ...(f.requires?.length ? { requires: f.requires } : {}),
        }
      : null;
    const ticket = signTicket(this.access.ticketKey, {
      v: 1,
      principal,
      sha256: sha,
      features,
      exp: until,
    });
    return { until, ticket };
  }

  /**
   * An Advanced prebuilt image: stored once, granted to its uploader only, under the same policy
   * as built firmware — capability, upload rate, storage quota, host resources.
   */
  async publishPrebuilt(principal: Principal, bytes: Buffer) {
    const plan = this.access.policy.plan(principal);
    if (!plan.capabilities.allowPrebuiltBinary) throw new Refusal('capability_disabled');
    this.checkStorage(principal);
    checkResources(
      this.access.policy.config.global.resources,
      this.workRoot,
      this.access.probe,
      false,
    );
    const rate = this.access.rates.take(principal, 'prebuilt-upload', plan.storage.prebuiltUploads);
    if (!rate.ok) throw new Refusal('rate_limited', rate.retryAfterMs);
    const artifact = await this.store.publish(bytes, 'prebuilt');
    this.access.grants.recordPrebuilt(principal, artifact.sha256, artifact.bytes);
    await this.enforceStorage(principal);
    admissionEvent('build', 'prebuilt', 'admitted', principal);
    return artifact;
  }

  /** Resolves when no build is active or queued (tests, shutdown). */
  whenIdle(): Promise<void> {
    if (this.active.size === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idle.add(resolve));
  }

  private cachedResult(principal: Principal, key: string): BuildResult | null {
    const found = this.access.grants.findBuild(principal, key);
    if (!found?.artifact) return null;
    if (!this.store.exists(found.artifact.sha256)) {
      this.access.grants.dropArtifact(found.artifact.sha256);
      return null;
    }
    this.store.used(found.artifact.sha256);
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

  private deferred: ReturnType<typeof setTimeout> | null = null;

  /**
   * Start the next build when capacity allows (Phase 4 admission):
   * - a build that waited longer than the policy allows fails as `capacity_timeout` (it never
   *   starts late into contention);
   * - while live runtime sessions occupy the CPUs, NO NEW build starts (sessions have priority;
   *   nothing that runs is ever stopped) — it waits in the queue and is retried every second;
   * - the same when that count is UNKNOWN (stale/unavailable Session Host health): fail closed, so
   *   a compile never starts on top of a live session nobody can see. A wait that outlasts the
   *   policy ends as `capacity_timeout` above.
   */
  private pump(): void {
    const policy = this.access.policy;
    const now = Date.now();
    for (const r of [...this.queue])
      if (now - r.submittedAt > policy.config.global.build.maxQueueWaitMs) {
        this.queue.splice(this.queue.indexOf(r), 1);
        r.result = this.failed(r, 'capacity_timeout', 'The build waited too long for capacity.', 0);
        r.state = 'failed';
        r.finishedAt = now;
        admissionEvent('build', 'start', 'builder_busy', r.submitter);
      }
    if (!this.queue.length) {
      if (this.active.size === 0) {
        for (const done of this.idle) done();
        this.idle.clear();
      }
      return;
    }
    // Start queued builds in order (fair: first come, first served) while workers are free.
    while (this.queue.length && this.active.size < policy.maxActiveBuilds) {
      const watch = this.access.liveSessions;
      const live = watch ? watch() : 0;
      if (live === null || live >= policy.deferBuildsAtLiveSessions) {
        if (!this.deferred)
          this.deferred = setTimeout(() => {
            this.deferred = null;
            this.pump();
          }, 1000);
        return;
      }
      const next = this.queue.shift()!;
      this.active.add(next);
      next.state = 'building';
      void this.execute(next);
    }
  }

  /** Compile one build to completion, then free its worker and start the next. */
  private async execute(next: BuildRecord): Promise<void> {
    try {
      next.result = await this.run(next);
    } catch (e) {
      // Operator log: the error only (never source text or identifiers).
      process.stderr.write(`build ${next.id}: internal error: ${(e as Error).message}\n`);
      next.result = this.failed(next, 'internal', 'Build service: internal error.', 0);
    }
    next.state = next.result.ok ? 'succeeded' : 'failed';
    next.finishedAt = Date.now();
    // Failed builds count toward the submitter's cool-down; they hold no capacity afterwards.
    // (Bookkeeping must never take the pump down: a failure here is logged, the queue goes on.)
    try {
      if (!next.result.ok && next.result.failure !== 'internal')
        this.access.rates.record(next.submitter, 'build-failure');
    } catch (e) {
      process.stderr.write(
        `build ${next.id}: could not record a failure: ${(e as Error).message}\n`,
      );
    }
    if (next.result.ok && next.owner === next.submitter)
      await this.enforceStorage(next.submitter).catch(() => undefined);
    this.active.delete(next);
    this.pump();
  }

  /** Builds of a principal currently queued or compiling (tests, operator summaries). */
  inFlight(principal: Principal): number {
    return (
      this.queue.filter((r) => r.submitter === principal).length +
      [...this.active].filter((r) => r.submitter === principal).length
    );
  }

  /** Stop the deferral timer (shutdown, tests). */
  close(): void {
    if (this.deferred) clearTimeout(this.deferred);
    this.deferred = null;
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
        // The job's output is untrusted (it comes out of the sandbox): only a well-formed
        // merged image is published, and the store computes its identity itself.
        const bytes = await readFile(out.imagePath);
        if (!isMergedImage(bytes))
          return this.failed(r, 'internal', 'Build service: the build produced no valid image.', 0);
        const artifact = await this.store.publish(bytes, 'build');
        this.access.grants.recordBuild(r.owner, { ...base, artifact });
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

/** A merged Classic ESP32 flash image: exactly 4 MiB, ESP image headers at 0x1000 and 0x10000. */
export function isMergedImage(b: Buffer): boolean {
  return b.length === 4 * 1024 * 1024 && b[0x1000] === 0xe9 && b[0x10000] === 0xe9;
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

/**
 * Browser client of the build service (`tbi-lab.build/1`, Sprint 7), reached same-origin under
 * `/build` behind the preview's authentication. Toolchain-neutral: it sends a profile and files
 * and receives an immutable artifact identity plus diagnostics. The service never stores the
 * project; the browser sends only the current source snapshot of one program.
 *
 * A build is submitted, then polled (the authenticating proxy cuts long requests, and a cold
 * compile takes tens of seconds). A cache hit answers at once. `lookup` finds an existing build
 * of exactly this source without building; `lease` pins an artifact just before a Run.
 */
import type {
  ArtifactInfo,
  BuildResult,
  BuildStatus,
  SourceFile,
} from '../../../runtime/builder/protocol.js';
import { BUILD_PROTOCOL } from '../../../runtime/builder/protocol.js';
import { gateFetch } from '../gate.js';

export type {
  ArtifactInfo,
  BuildResult,
  Diagnostic,
  FeatureReport,
} from '../../../runtime/builder/protocol.js';

export type BuildErrorCode =
  | 'unreachable'
  | 'busy'
  | 'refused'
  | 'too_large'
  | 'not_an_image'
  | 'protocol'
  // Sprint 8 policy refusals (stable server codes, runtime/policy/refusal.ts):
  | 'quota'
  | 'rate_limited'
  | 'cooldown'
  | 'storage_quota'
  | 'capability_disabled';

/** A policy refusal from the build service, as this client's error code (or null). */
function refusal(body: unknown): BuildErrorCode | null {
  switch ((body as { error?: unknown } | null)?.error) {
    case 'build_quota':
      return 'quota';
    case 'build_cooldown':
      return 'cooldown';
    case 'rate_limited':
      return 'rate_limited';
    case 'storage_quota':
      return 'storage_quota';
    case 'capability_disabled':
      return 'capability_disabled';
    case 'builder_busy':
    case 'storage_pressure':
    case 'memory_pressure':
      return 'busy';
    default:
      return null;
  }
}

export class BuildTransportError extends Error {
  constructor(
    readonly code: BuildErrorCode,
    readonly status?: number,
  ) {
    super(code);
  }
}

export interface BuildClientOptions {
  base?: string;
  fetch?: typeof fetch;
  pollMs?: number;
  /** Give up polling after this long (the service's hard timeout plus queueing headroom). */
  maxWaitMs?: number;
}

export class BuildClient {
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly pollMs: number;
  private readonly maxWaitMs: number;

  constructor(opts: BuildClientOptions = {}) {
    this.base = (opts.base ?? '/build').replace(/\/$/, '');
    this.fetchFn = opts.fetch ?? ((input, init) => gateFetch(input, init));
    this.pollMs = opts.pollMs ?? 500;
    this.maxWaitMs = opts.maxWaitMs ?? 20 * 60 * 1000;
  }

  private async request(
    path: string,
    init: RequestInit = {},
  ): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}/v1${path}`, { credentials: 'same-origin', ...init });
    } catch {
      throw new BuildTransportError('unreachable');
    }
    let body: unknown;
    const type = res.headers.get('content-type') ?? '';
    if (!/^application\/json\b/.test(type)) {
      // A login page or proxy error instead of the service: not something to interpret.
      throw new BuildTransportError(res.status >= 500 ? 'unreachable' : 'protocol', res.status);
    }
    try {
      body = await res.json();
    } catch {
      throw new BuildTransportError('protocol', res.status);
    }
    return { status: res.status, body };
  }

  /** Build (or find) the artifact for these files. `onProgress` reports queued/building. */
  async build(
    profile: string,
    files: SourceFile[],
    onProgress?: (s: BuildStatus['state'], position?: number) => void,
    signal?: AbortSignal,
  ): Promise<BuildResult> {
    const { status, body } = await this.request('/builds', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: BUILD_PROTOCOL, profile, files }),
    });
    if (status === 200) return (body as { build: BuildResult }).build;
    const refused = refusal(body);
    if (refused) throw new BuildTransportError(refused, status);
    if (status === 429) throw new BuildTransportError('busy', status);
    if (status === 413) throw new BuildTransportError('too_large', status);
    if (status !== 202)
      throw new BuildTransportError(status >= 500 ? 'unreachable' : 'refused', status);
    const { buildId, token } = body as { buildId: string; token: string };
    const started = Date.now();
    for (;;) {
      if (signal?.aborted) throw new BuildTransportError('unreachable');
      await new Promise((r) => setTimeout(r, this.pollMs));
      const s = await this.request(`/builds/${buildId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (s.status !== 200) throw new BuildTransportError('protocol', s.status);
      const st = s.body as BuildStatus;
      if ((st.state === 'succeeded' || st.state === 'failed') && st.result) return st.result;
      onProgress?.(st.state, st.position);
      if (Date.now() - started > this.maxWaitMs) throw new BuildTransportError('unreachable');
    }
  }

  /** An existing successful build of exactly this source key, or null. Never builds. */
  async lookup(key: string): Promise<BuildResult | null> {
    const { status, body } = await this.request(`/lookup?key=${encodeURIComponent(key)}`);
    if (status === 404) return null;
    if (status !== 200) throw new BuildTransportError('protocol', status);
    return (body as { build: BuildResult }).build;
  }

  /**
   * Pin an artifact against eviction for the next Run and obtain its run ticket (Sprint 8): the
   * build service's statement that this user may run it, which the Session Host requires. Null
   * when the artifact no longer exists, or is not this user's: a new Build is needed.
   */
  async lease(sha256: string): Promise<string | null> {
    const { status, body } = await this.request(`/artifacts/${sha256}/lease`, { method: 'POST' });
    if (status === 404) return null;
    const refused = refusal(body);
    if (refused) throw new BuildTransportError(refused, status);
    if (status !== 200) throw new BuildTransportError('protocol', status);
    const ticket = (body as { ticket?: unknown }).ticket;
    if (typeof ticket !== 'string') throw new BuildTransportError('protocol', status);
    return ticket;
  }

  /** Advanced: upload a prebuilt merged flash image; the service computes its identity. */
  async uploadPrebuilt(bytes: ArrayBuffer): Promise<ArtifactInfo> {
    const { status, body } = await this.request('/artifacts', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes,
    });
    const refused = refusal(body);
    if (refused) throw new BuildTransportError(refused, status);
    if (status === 413) throw new BuildTransportError('too_large', status);
    if (status === 422) throw new BuildTransportError('not_an_image', status);
    if (status !== 200) throw new BuildTransportError('protocol', status);
    return (body as { artifact: ArtifactInfo }).artifact;
  }
}

/**
 * Build service protocol `tbi-lab.build/1` (Sprint 7): HTTP + JSON.
 *
 * Toolchain-neutral on purpose. A request names a *profile* (board + programming environment +
 * pinned toolchain configuration) and carries the source *files*; the profile's provider decides
 * how they become a runnable artifact. Arduino/C++ for the Classic ESP32 is the first provider;
 * other environments (MicroPython, ESP-IDF, other boards) plug in as further profiles without
 * changing this contract. The browser remains the project authority: the service never stores
 * projects, only immutable artifacts and short-lived build records.
 *
 *   POST /v1/builds                  BuildRequest -> 200 {build} (cache hit) | 202 {buildId, token}
 *   GET  /v1/builds/:id              (Authorization: Bearer token) -> BuildStatus
 *   GET  /v1/lookup?key=<sourceKey>  -> 200 {build} | 404   (never builds)
 *   POST /v1/artifacts               raw bytes (Advanced prebuilt image) -> 200 {artifact}
 *   POST /v1/artifacts/:sha/lease    -> 200 {artifact, leaseUntil} | 404   (pin before a Run)
 *   GET  /v1/health
 */

export const BUILD_PROTOCOL = 'tbi-lab.build/1';

export interface SourceFile {
  /** Fixed per profile (for example `sketch.ino`); never a path. */
  name: string;
  /** Exact source text (UTF-8). */
  text: string;
}

export interface BuildRequest {
  protocol: typeof BUILD_PROTOCOL;
  profile: string;
  files: SourceFile[];
}

export type Severity = 'error' | 'warning' | 'note';

export interface Diagnostic {
  severity: Severity;
  /** Source file name as in the request (never a server path). */
  file?: string;
  line?: number;
  column?: number;
  message: string;
}

/** Firmware capability declaration for the runtime (R2 `firmwareFeatures` plus product notes). */
export interface FeatureReport {
  /** GPIOs configured with an internal pull (all input-capable pins when not determinable). */
  internalPull: number[];
  /** GPIOs with interrupts attached (all input-capable pins when not determinable). */
  gpioInterrupt: number[];
  /** The source asks for a chip restart (unsupported: the runtime ends the session). */
  restart: boolean;
  /** Core facilities the simulator does not model (for example `wifi`, `i2c`, `spi`). */
  unsupported: string[];
  /**
   * Sprint 12 (ADR-011 §5): runtime bridge capabilities the firmware needs (e.g. `i2c` for
   * Wire), when the configured runtime provides them. Absent when none.
   */
  requires?: string[];
}

export interface ArtifactInfo {
  /** sha256 of the artifact bytes, computed by the service. */
  sha256: string;
  bytes: number;
  /** Where it came from: a build of source, or an Advanced prebuilt upload. */
  origin: 'build' | 'prebuilt';
}

export interface BuildResult {
  /** Content key of the build input (profile + files): equal input, equal key. */
  key: string;
  profile: string;
  profileHash: string;
  ok: boolean;
  artifact?: ArtifactInfo;
  features?: FeatureReport;
  /** Firmware sizes reported by the toolchain, when known. */
  sizes?: { program: number; programMax: number; data: number; dataMax: number };
  diagnostics: Diagnostic[];
  /** Bounded raw toolchain output (details view only). */
  log: { text: string; truncated: boolean };
  /** The reason a build could not complete (timeout, resource limit, internal). */
  failure?:
    | 'compile_error'
    | 'timeout'
    | 'storage_limit'
    | 'unsupported_input'
    | 'internal'
    /** Sprint 8: waited in the queue longer than the policy allows (capacity was busy). */
    | 'capacity_timeout';
  timings: { queuedMs: number; buildMs: number };
}

export type BuildState = 'queued' | 'building' | 'succeeded' | 'failed';

export interface BuildStatus {
  buildId: string;
  state: BuildState;
  /** Position in the queue (0 = next) while queued. */
  position?: number;
  result?: BuildResult;
}

export class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(reason);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Structural validation only; the profile applies its own rules (names, sizes) afterwards. */
export function validateBuildRequest(body: unknown): BuildRequest {
  if (!isObj(body)) throw new RequestError(400, 'bad_request');
  for (const k of Object.keys(body))
    if (!['protocol', 'profile', 'files'].includes(k)) throw new RequestError(400, 'unknown_field');
  if (body.protocol !== BUILD_PROTOCOL) throw new RequestError(400, 'unsupported_protocol');
  if (typeof body.profile !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(body.profile))
    throw new RequestError(400, 'bad_profile');
  if (!Array.isArray(body.files) || body.files.length === 0 || body.files.length > 16)
    throw new RequestError(400, 'bad_files');
  const files = body.files.map((f) => {
    if (!isObj(f) || Object.keys(f).some((k) => k !== 'name' && k !== 'text'))
      throw new RequestError(400, 'bad_files');
    if (typeof f.name !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(f.name))
      throw new RequestError(400, 'bad_file_name');
    if (typeof f.text !== 'string' || f.text.includes('\u0000'))
      throw new RequestError(400, 'bad_file_text');
    return { name: f.name, text: f.text };
  });
  return { protocol: BUILD_PROTOCOL, profile: body.profile, files };
}

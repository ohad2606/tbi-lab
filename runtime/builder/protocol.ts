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
  /**
   * The entry file's fixed name (for example `sketch.ino`), or (Sprint 26) a further project file's
   * relative path (`display.h`, `src/util.cpp`, `pkg/mod.py`): the profile checks it
   * (domain `programPathIssue`) before anything is written.
   */
  name: string;
  /** Exact source text (UTF-8). */
  text: string;
}

export interface BuildRequest {
  protocol: typeof BUILD_PROTOCOL;
  profile: string;
  files: SourceFile[];
  /** Sprint 26: the managed libraries to build with (registry id and exact version). */
  libraries?: { id: string; version: string }[];
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
  /**
   * Sprint 25 (Runtime v5, `input-read`): the GPIOs the program may read as digital inputs (or
   * attach an interrupt to), and whether a read names a pin the analysis cannot resolve. Present
   * only when the runtime announces `input-read`; the Session Host refuses a read of such a pin
   * while its level is undefined.
   */
  inputReads?: { pins: number[]; unresolved: boolean };
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
    if (!['protocol', 'profile', 'files', 'libraries'].includes(k))
      throw new RequestError(400, 'unknown_field');
  if (body.protocol !== BUILD_PROTOCOL) throw new RequestError(400, 'unsupported_protocol');
  if (typeof body.profile !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(body.profile))
    throw new RequestError(400, 'bad_profile');
  if (!Array.isArray(body.files) || body.files.length === 0 || body.files.length > 16)
    throw new RequestError(400, 'bad_files');
  const files = body.files.map((f) => {
    if (!isObj(f) || Object.keys(f).some((k) => k !== 'name' && k !== 'text'))
      throw new RequestError(400, 'bad_files');
    // A name, or (Sprint 26) a relative path of such names: no `.`/`..`, no empty segment.
    if (
      typeof f.name !== 'string' ||
      f.name.length > 96 ||
      !f.name.split('/').every((seg) => /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(seg))
    )
      throw new RequestError(400, 'bad_file_name');
    if (typeof f.text !== 'string' || f.text.includes('\u0000'))
      throw new RequestError(400, 'bad_file_text');
    return { name: f.name, text: f.text };
  });
  if (new Set(files.map((f) => f.name.toLowerCase())).size !== files.length)
    throw new RequestError(400, 'bad_files');
  let libraries: BuildRequest['libraries'];
  if (body.libraries !== undefined) {
    if (!Array.isArray(body.libraries) || body.libraries.length > 8)
      throw new RequestError(400, 'bad_libraries');
    libraries = body.libraries.map((l) => {
      if (
        !isObj(l) ||
        Object.keys(l).some((k) => k !== 'id' && k !== 'version') ||
        typeof l.id !== 'string' ||
        typeof l.version !== 'string' ||
        !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(l.id) ||
        !/^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/.test(l.version)
      )
        throw new RequestError(400, 'bad_libraries');
      return { id: l.id, version: l.version };
    });
    if (new Set(libraries.map((l) => l.id)).size !== libraries.length)
      throw new RequestError(400, 'bad_libraries');
  }
  return {
    protocol: BUILD_PROTOCOL,
    profile: body.profile,
    files,
    ...(libraries?.length ? { libraries } : {}),
  };
}

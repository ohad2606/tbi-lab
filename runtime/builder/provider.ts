/**
 * Build providers: one per build profile (board + programming environment + pinned toolchain).
 * The service owns queueing, limits, the artifact store and cleanup; a provider only turns the
 * files in a private job directory into an image (or diagnostics). Providers never see other
 * jobs, never choose paths outside their job directory and never take options from the client.
 */
import type { BuildProfile } from '@tbi-lab/domain';
import type { Diagnostic, FeatureReport } from './protocol.js';

export interface JobContext {
  /** Private, empty, per-job directory (0700). The provider writes only here. */
  dir: string;
  files: { name: string; text: string }[];
  /** Aborted on timeout or resource limit: the provider must stop its processes promptly. */
  signal: AbortSignal;
  /**
   * Sprint 18F: the source is one of the product's curated sketches (never a user's own): its
   * build may leave reusable toolchain state for later jobs (the Arduino core seed).
   */
  curated?: boolean;
}

export interface ProviderOutput {
  ok: boolean;
  /** Absolute path of the finished image inside the job directory (when ok). */
  imagePath?: string;
  features?: FeatureReport;
  sizes?: { program: number; programMax: number; data: number; dataMax: number };
  diagnostics: Diagnostic[];
  /** Sprint 18F: the core seed this build started from (`seeded`), or why it compiled cold. */
  coreSeed?: 'seeded' | 'cold';
  /** Raw toolchain output, already bounded by the provider's output cap. */
  log: { text: string; truncated: boolean };
  failure?: 'compile_error' | 'unsupported_input' | 'internal';
}

export interface BuildProvider {
  readonly profile: BuildProfile;
  /** sha256 over the canonical pinned-input record (toolchain file hashes, options). */
  readonly profileHash: string;
  /** Refuse to serve when the installed toolchain does not match the pins. */
  verifyToolchain(): Promise<void>;
  build(job: JobContext): Promise<ProviderOutput>;
  /**
   * Sprint 18F: whether a job in `jobDir` (a path under the service's work root) would start
   * from reusable toolchain state (the core seed). Absent: the provider keeps none.
   */
  hasCoreSeed?(jobDir: string): Promise<boolean>;
}

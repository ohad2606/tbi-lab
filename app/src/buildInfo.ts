/**
 * The identity of the running build (Sprint 10): compiled in at build time by the Vite config
 * (buildInfo.config.ts), the same object that is published as /version.json. What the UI shows is
 * therefore the code this browser is executing, never something read from a server.
 */

export interface BuildInfo {
  product: 'TBI Lab';
  version: string;
  environment: string;
  commit: string;
  shortCommit: string;
  builtAt: string;
  dirty: boolean;
}

declare const __TBI_BUILD__: unknown;

/** Validate a build identity object (defensive: a malformed define shows as unknown). */
export function parseBuildInfo(v: unknown): BuildInfo | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const ok =
    o.product === 'TBI Lab' &&
    typeof o.version === 'string' &&
    typeof o.environment === 'string' &&
    typeof o.commit === 'string' &&
    /^[0-9a-f]{40}$/.test(o.commit) &&
    o.shortCommit === o.commit.slice(0, 7) &&
    typeof o.builtAt === 'string' &&
    typeof o.dirty === 'boolean';
  return ok ? (o as unknown as BuildInfo) : null;
}

/** The running build, or null where none was compiled in (unit tests). */
export const BUILD_INFO: BuildInfo | null = parseBuildInfo(
  typeof __TBI_BUILD__ === 'undefined' ? null : __TBI_BUILD__,
);

/** The compact label: `v0.10-dev · 9c94329` (technical tokens, always left-to-right). */
export function versionLabel(info: BuildInfo): string {
  return `v${info.version} · ${info.shortCommit}${info.dirty ? '+' : ''}`;
}

/**
 * Build identity (Sprint 10, owner requirement): created ONCE per build, at build time, and both
 * compiled into the app (`__TBI_BUILD__`, shown in the UI) and emitted as `/version.json`, so the
 * version a user sees is the code their browser runs. Never derived at runtime from a server.
 *
 * Inputs (the deployment script sets them; local builds fall back to git and the clock):
 *   TBI_BUILD_COMMIT  full 40-hex commit the build is made from (else `git rev-parse HEAD`)
 *   TBI_BUILD_ENV     environment name, e.g. dev-lab (else "local")
 *   TBI_BUILD_TIME    ISO timestamp (else the build's start time) — the only field that may
 *                     differ between two builds of the same commit and environment
 * The product version is the repository's VERSION file (a stable development version such as
 * 0.10-dev; the commit identifies the exact build).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface BuildInfo {
  product: 'TBI Lab';
  version: string;
  environment: string;
  commit: string;
  shortCommit: string;
  builtAt: string;
  /** True when built from a working tree with uncommitted changes (never for a deployment). */
  dirty: boolean;
}

const HEX40 = /^[0-9a-f]{40}$/;
const ENV = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function makeBuildInfo(input: {
  version: string;
  commit: string;
  environment?: string;
  builtAt?: string;
  dirty?: boolean;
}): BuildInfo {
  const version = input.version.trim();
  if (!/^\d+\.\d+(\.\d+)?(-[a-z0-9.]+)?$/.test(version)) throw new Error(`bad version: ${version}`);
  const commit = input.commit.trim().toLowerCase();
  if (!HEX40.test(commit)) throw new Error(`bad commit: ${commit}`);
  const environment = input.environment ?? 'local';
  if (!ENV.test(environment)) throw new Error(`bad environment: ${environment}`);
  const builtAt = new Date(input.builtAt ?? Date.now()).toISOString();
  return {
    product: 'TBI Lab',
    version,
    environment,
    commit,
    shortCommit: commit.slice(0, 7),
    builtAt,
    dirty: input.dirty ?? false,
  };
}

/** The identity of the build being made now (inputs above). */
export function currentBuildInfo(root: URL): BuildInfo {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const commit = process.env.TBI_BUILD_COMMIT ?? git('rev-parse', 'HEAD');
  const dirty = process.env.TBI_BUILD_COMMIT
    ? false
    : git('status', '--porcelain', '--untracked-files=no') !== '';
  return makeBuildInfo({
    version: readFileSync(new URL('VERSION', root), 'utf8'),
    commit,
    environment: process.env.TBI_BUILD_ENV,
    builtAt: process.env.TBI_BUILD_TIME,
    dirty,
  });
}

/** The exact bytes of /version.json for a build identity. */
export const versionJson = (info: BuildInfo) => `${JSON.stringify(info, null, 2)}\n`;

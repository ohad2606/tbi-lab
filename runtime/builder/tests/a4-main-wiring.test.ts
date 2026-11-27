/**
 * Capacity A4: what `builder/main.ts` itself wires: the store asks the service which images are
 * pinned, and the repeated prewarm gets the curated requests; TBI_BUILD_PREWARM=0 turns both off.
 * The real main.ts is imported; only the toolchain check, the listener and the prewarm timer are
 * replaced, so nothing is compiled and nothing listens.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BuildService } from '../service.js';
import type { StoreOptions } from '../store.js';
import { systemBuildRequests } from '../system-sources.js';
import { tempDir } from './support.js';

const wired = vi.hoisted(() => ({ prewarm: [] as unknown[][] }));
vi.mock('../prewarm.js', async (original) => ({
  ...(await original<typeof import('../prewarm.js')>()),
  startPrewarm: (...args: unknown[]) => {
    wired.prewarm.push(args);
    return () => undefined;
  },
}));
vi.mock('../arduino.js', async (original) => {
  const real = await original<typeof import('../arduino.js')>();
  class NoToolchain extends real.ArduinoEsp32Provider {
    override async verifyToolchain(): Promise<void> {}
  }
  return { ...real, ArduinoEsp32Provider: NoToolchain };
});
vi.mock('../../identity/listen.js', async (original) => ({
  ...(await original<typeof import('../../identity/listen.js')>()),
  listen: async () => undefined,
}));

const dirs: string[] = [];
const signals = ['SIGTERM', 'SIGINT'] as const;
const before = new Map(signals.map((s) => [s, process.listeners(s)]));
afterEach(() => {
  for (const s of signals)
    for (const l of process.listeners(s))
      if (!before.get(s)!.includes(l)) process.removeListener(s, l);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(prewarm: string | undefined) {
  wired.prewarm.length = 0;
  const root = tempDir('tbi-a4-main-');
  dirs.push(root);
  const key = join(root, 'key');
  writeFileSync(key, randomBytes(32), { mode: 0o600 });
  for (const d of ['state', 'store', 'work']) mkdirSync(join(root, d));
  const env: Record<string, string | undefined> = {
    TBI_RUNTIME_HOME: root,
    TBI_BUILD_STATE: join(root, 'state'),
    TBI_ARTIFACT_STORE: join(root, 'store'),
    TBI_BUILD_WORK: join(root, 'work'),
    TBI_IDENTITY_KEY_FILE: key,
    TBI_TICKET_KEY_FILE: key,
    TBI_BUILD_PREWARM: prewarm,
  };
  // Nothing of the host's own deployment settings may reach the import.
  for (const name of Object.keys(process.env))
    if (name.startsWith('TBI_')) vi.stubEnv(name, undefined);
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.resetModules();
  const { BuildService: Fresh } = await import('../service.js');
  const isPinned = vi.spyOn(Fresh.prototype, 'isPinned').mockReturnValue(true);
  const sweep = vi.spyOn(Fresh.prototype, 'sweep');
  await import('../main.js');
  const service = sweep.mock.contexts[0] as BuildService;
  const options = (service.store as unknown as { opts: StoreOptions }).opts;
  return { service, options, isPinned };
}

describe('build service main: curated pin and prewarm wiring', () => {
  it('by default the store asks the service, and the curated requests are prewarmed once', async () => {
    const m = await boot(undefined);
    const sha = 'a'.repeat(64);
    expect(m.options.isPinned?.(sha)).toBe(true);
    expect(m.isPinned).toHaveBeenCalledWith(sha);
    expect(wired.prewarm).toHaveLength(1);
    expect(wired.prewarm[0]![0]).toBe(m.service);
    expect(wired.prewarm[0]![1]).toEqual(systemBuildRequests());
  }, 60_000);

  it('TBI_BUILD_PREWARM=0: no pinning and no prewarm', async () => {
    const m = await boot('0');
    expect(m.options.isPinned).toBeUndefined();
    expect(wired.prewarm).toEqual([]);
  }, 60_000);
});

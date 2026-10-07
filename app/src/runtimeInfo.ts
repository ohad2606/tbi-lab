/**
 * The ESP32 runtime's build identity (Sprint 10): the Session Host reports its product version and
 * exact commit on /health when its bundle was stamped (runtime/host/identity.ts). The version
 * details show it next to the app's own commit, so a review knows exactly which runtime answered.
 * Read once, on demand; only a version token and a 40-hex commit are accepted (nothing else is
 * shown); anything else (no backend, an older runtime) is "not reported".
 */
export interface RuntimeIdentity {
  version: string;
  commit: string;
}

export function parseRuntimeIdentity(body: unknown): RuntimeIdentity | null {
  const r = (body as { runtime?: { version?: unknown; commit?: unknown } } | null)?.runtime;
  if (!r || typeof r.version !== 'string' || typeof r.commit !== 'string') return null;
  if (!/^[0-9a-z.+-]{1,32}$/i.test(r.version) || !/^[0-9a-f]{40}$/.test(r.commit)) return null;
  return { version: r.version, commit: r.commit };
}

export async function probeRuntime(base = '/runtime'): Promise<RuntimeIdentity | null> {
  try {
    const res = await fetch(`${base}/health`, { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) return null;
    return parseRuntimeIdentity(await res.json());
  } catch {
    return null;
  }
}

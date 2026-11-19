import { parseConfig, type PlansConfig } from '../config.js';
import { PlansEngine, type AdmitResult } from '../reserve.js';
import { MemoryAlertSink } from '../spend.js';
import { MemoryStore, type Store } from '../store.js';
import { FakeClock } from '../time.js';

export const ms = (iso: string): number => Date.parse(iso);
/** noon in Jerusalem on 2026-11-19 */
export const NOON = ms('2026-11-19T10:00:00Z');
export const FREE = 'p_freeuser0001';
export const ADV = 'p_advanced0001';
export const LEG = 'p_legacy00001';

export async function setup(
  overrides: unknown = {},
  opts: { store?: Store; start?: number; enabled?: boolean } = {},
) {
  const cfg: PlansConfig = parseConfig({
    ...(overrides as object),
    metering: { enabled: opts.enabled ?? true },
  });
  const clock = new FakeClock(opts.start ?? NOON);
  const store = opts.store ?? new MemoryStore();
  const sink = new MemoryAlertSink();
  const engine = await PlansEngine.open(store, { config: cfg, clock, alerts: sink });
  return { engine, store, clock, sink, cfg };
}

let n = 0;
export const req = (principal: string, mode: 'standard' | 'deep' = 'standard', inputTokens = 100) => ({
  reqId: `r${++n}`,
  principal,
  mode,
  inputTokens,
});

export const code = (r: AdmitResult): string => (r.ok ? 'ok' : r.error.code);

export const NOV = { start: ms('2026-11-01T00:00:00Z'), end: ms('2026-12-01T00:00:00Z') };

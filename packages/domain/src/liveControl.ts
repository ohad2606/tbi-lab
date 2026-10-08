/**
 * Live controls (Sprint 11, R1; ADR-010): which persistent values a RUNNING simulation may
 * receive for a component, and whether a value is acceptable. One rule, used by the Session Host
 * when a mirror command arrives and by the engine when it applies one, so the two can never
 * disagree.
 *
 * - The lab PSU takes `setpointVoltage`, `currentLimit`, `outputEnabled`; a toggle switch takes
 *   `closed` (their value checks stay where they always were: the engine).
 * - Other parts take `params`: only the parameters their catalog entry declares `live`, each of
 *   the declared kind and within the declared range (e.g. a photoresistor's `illuminance`
 *   1–10 000 lux, a PIR sensor's `motion` boolean). Quantities travel in SI units, as numbers.
 */
import { CATALOG } from './catalog.js';
import type { ComponentTypeId } from './schema.js';

export interface LiveControlRequest {
  setpointVoltage?: unknown;
  currentLimit?: unknown;
  outputEnabled?: unknown;
  closed?: unknown;
  params?: Record<string, unknown>;
}

/** Why a live control is refused: the control does not exist for this part, or its value is bad. */
export interface LiveControlProblem {
  reason: 'unsupported_control' | 'invalid_value';
  key?: string;
}

const PSU_KEYS = ['setpointVoltage', 'currentLimit', 'outputEnabled'] as const;
const NAMED_KEYS: readonly string[] = [...PSU_KEYS, 'closed'];

/** The `params` keys a component type accepts while running (its catalog `live` parameters). */
export function liveParamKeys(type: ComponentTypeId): string[] {
  return CATALOG[type].params
    .filter((p) => p.live && !NAMED_KEYS.includes(p.key))
    .map((p) => p.key);
}

/** Null when `control` is a live control `type` accepts, with acceptable `params` values. */
export function liveControlProblem(
  type: ComponentTypeId,
  control: LiveControlRequest,
): LiveControlProblem | null {
  const unsupported = (key?: string): LiveControlProblem => ({
    reason: 'unsupported_control',
    ...(key ? { key } : {}),
  });
  const psu = PSU_KEYS.filter((k) => control[k] !== undefined);
  if (psu.length && type !== 'instrument.lab_psu') return unsupported(psu[0]);
  if (control.closed !== undefined && type !== 'component.toggle_switch')
    return unsupported('closed');
  const params = control.params;
  if (params === undefined) return null;
  const keys = Object.keys(params);
  if (!keys.length) return unsupported();
  const def = CATALOG[type];
  for (const key of keys) {
    const p = def.params.find((x) => x.key === key);
    if (!p || !p.live || NAMED_KEYS.includes(key)) return unsupported(key);
    const v = params[key];
    const bad = { reason: 'invalid_value' as const, key };
    if (p.kind === 'quantity') {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < p.min || v > p.max) return bad;
    } else if (p.kind === 'boolean') {
      if (typeof v !== 'boolean') return bad;
    } else if (typeof v !== 'string' || !p.options.some((o) => o.value === v)) return bad;
  }
  return null;
}

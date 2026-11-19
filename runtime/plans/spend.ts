/**
 * TBI-018 slice 1: SpendGuard logic. Daily/monthly LLM spend counters, caps, alert thresholds, the
 * kill-switch state machine. Pure functions over `SpendState`; the engine (reserve.ts) journals the
 * outcomes. Money is integer micro-USD. Day/month keys come from the metering time zone.
 */
import type { PlansConfig } from './config.js';

export type SpendMode = 'on' | 'auto_stopped' | 'manual_off';
export type StopReason = 'daily_cap' | 'monthly_cap' | 'auto_trigger';

export interface SpendState {
  dayKey: string;
  dayMicro: number;
  monthKey: string;
  monthMicro: number;
  /** worst cases of open reservations (counted against both day and month headroom) */
  reservedMicro: number;
  state: SpendMode;
  stopReason?: StopReason;
  alertsFired: string[];
  dayExtraMicro: number;
  /** totals of completed (rolled) days, newest last; used by the auto-trigger */
  history: { dayKey: string; micro: number }[];
}

export function initialSpend(): SpendState {
  return {
    dayKey: '',
    dayMicro: 0,
    monthKey: '',
    monthMicro: 0,
    reservedMicro: 0,
    state: 'on',
    alertsFired: [],
    dayExtraMicro: 0,
    history: [],
  };
}

/** Spend-affecting part of a journal event. */
export type SpendDelta =
  | { k: 'roll'; dayKey: string; monthKey: string; clearState: boolean }
  | { k: 'reserve'; micro: number }
  | { k: 'settle'; reservedMicro: number; actualMicro: number; stop?: StopReason; alerts: string[] }
  | {
      k: 'release';
      reservedMicro: number;
      countedMicro: number;
      stop?: StopReason;
      alerts: string[];
    }
  | { k: 'trip'; stop: StopReason; alerts: string[] }
  | { k: 'resume'; extraDayMicro: number }
  | { k: 'pause' }
  | { k: 'seed'; patch: Partial<SpendState> };

export function applySpend(s: SpendState, d: SpendDelta): SpendState {
  const n: SpendState = { ...s, alertsFired: [...s.alertsFired], history: [...s.history] };
  switch (d.k) {
    case 'roll': {
      if (d.dayKey !== s.dayKey) {
        if (s.dayKey !== '')
          n.history = [...s.history, { dayKey: s.dayKey, micro: s.dayMicro }].slice(-30);
        n.dayKey = d.dayKey;
        n.dayMicro = 0;
        n.dayExtraMicro = 0;
        n.alertsFired = n.alertsFired.filter((a) => !a.startsWith('day_'));
      }
      if (d.monthKey !== s.monthKey) {
        n.monthKey = d.monthKey;
        n.monthMicro = 0;
        n.alertsFired = n.alertsFired.filter((a) => !a.startsWith('month_'));
        if (s.state === 'auto_stopped' && s.stopReason === 'monthly_cap') {
          n.state = 'on';
          delete n.stopReason;
        }
      }
      if (d.clearState && s.state === 'auto_stopped' && s.stopReason === 'daily_cap') {
        n.state = 'on';
        delete n.stopReason;
      }
      return n;
    }
    case 'reserve':
      n.reservedMicro += d.micro;
      return n;
    case 'settle':
    case 'release': {
      n.reservedMicro -= d.reservedMicro;
      const add = d.k === 'settle' ? d.actualMicro : d.countedMicro;
      n.dayMicro += add;
      n.monthMicro += add;
      return withStop(n, d.stop, d.alerts);
    }
    case 'trip':
      return withStop(n, d.stop, d.alerts);
    case 'resume':
      n.state = 'on';
      delete n.stopReason;
      n.dayExtraMicro += d.extraDayMicro;
      return n;
    case 'pause':
      n.state = 'manual_off';
      delete n.stopReason;
      return n;
    case 'seed':
      return { ...n, ...d.patch };
  }
}

function withStop(n: SpendState, stop: StopReason | undefined, alerts: string[]): SpendState {
  if (stop) {
    n.state = 'auto_stopped';
    n.stopReason = stop;
  }
  for (const a of alerts) if (!n.alertsFired.includes(a)) n.alertsFired.push(a);
  return n;
}

/** Roll the counters to the current day/month. Returns the new state and the delta to journal (if any). */
export function rollSpend(
  s: SpendState,
  dayKey: string,
  monthKey: string,
  cfg: PlansConfig,
): { spend: SpendState; delta?: SpendDelta } {
  if (s.dayKey === dayKey && s.monthKey === monthKey) return { spend: s };
  const delta: SpendDelta = {
    k: 'roll',
    dayKey,
    monthKey,
    clearState: dayKey !== s.dayKey && cfg.spend.autoClearNextDay,
  };
  return { spend: applySpend(s, delta), delta };
}

/** Would a reservation of `worst` stay inside the day and month caps? */
export function reserveCheck(
  s: SpendState,
  worst: number,
  cfg: PlansConfig,
): { ok: true } | { ok: false; stop: StopReason } {
  if (s.monthMicro + s.reservedMicro + worst > cfg.spend.monthStopMicro)
    return { ok: false, stop: 'monthly_cap' };
  if (s.dayMicro + s.reservedMicro + worst > cfg.spend.dayStopMicro + s.dayExtraMicro)
    return { ok: false, stop: 'daily_cap' };
  return { ok: true };
}

/** Alerts not yet fired for the counters in `s` (exactly once per threshold per period). */
export function newAlerts(s: SpendState, cfg: PlansConfig): string[] {
  const out: string[] = [];
  const add = (code: string, hit: boolean): void => {
    if (hit && !s.alertsFired.includes(code)) out.push(code);
  };
  add('day_50', s.dayMicro >= cfg.spend.dayAlertMicro);
  add('day_100', s.dayMicro >= cfg.spend.dayStopMicro + s.dayExtraMicro);
  for (const p of cfg.spend.monthAlertPercents)
    add(`month_${p}`, s.monthMicro * 100 >= cfg.spend.monthStopMicro * p);
  add('month_100', s.monthMicro >= cfg.spend.monthStopMicro);
  return out;
}

/** After counters changed: which stop (if any) applies now, plus new alerts. Only a state of `on` can be stopped. */
export function evaluate(s: SpendState, cfg: PlansConfig): { stop?: StopReason; alerts: string[] } {
  const alerts = newAlerts(s, cfg);
  if (s.state !== 'on') return { alerts };
  if (s.monthMicro >= cfg.spend.monthStopMicro) return { stop: 'monthly_cap', alerts };
  if (s.dayMicro >= cfg.spend.dayStopMicro + s.dayExtraMicro) return { stop: 'daily_cap', alerts };
  const at = cfg.killSwitch.autoTrigger;
  if (at.enabled && s.history.length > 0) {
    const last = s.history.slice(-7);
    const sum = last.reduce((a, h) => a + h.micro, 0);
    // dayMicro > multiple x average  <=>  dayMicro x n > multiple x sum (no floating point)
    if (s.dayMicro * last.length > at.multiple * sum && s.dayMicro > at.minMicro)
      return { stop: 'auto_trigger', alerts };
  }
  return { alerts };
}

export interface SpendAlert {
  code: string;
  at: number;
  dayMicro: number;
  monthMicro: number;
  dayStopMicro: number;
  monthStopMicro: number;
}

/** Where alerts go. No channel is chosen in this slice; the in-memory sink is for tests. */
export interface AlertSink {
  alert(a: SpendAlert): void | Promise<void>;
}

export class MemoryAlertSink implements AlertSink {
  readonly alerts: SpendAlert[] = [];
  alert(a: SpendAlert): void {
    this.alerts.push(a);
  }
}

/**
 * Sprint 27 Phase 2: the deterministic circuit debugger. It reads ONE thing, the Engineering
 * Context, and turns the product's verified records in it (editor checks, the engine's refusal,
 * its rating rows, the build service's diagnostics and feature report, the runtime's failure)
 * into findings with stable identifiers. It adds no physics: every finding is one of those records
 * (or the explicit absence of one), cites it as evidence, and says how certain it is:
 *
 * - `verified`: the electrical engine, the runtime or the build service established it;
 * - `conservative`: an editor-time check or static code analysis (may miss cases, never invents);
 * - `indeterminate`: the product has no defensible value or no result to judge from.
 *
 * This is the trusted layer the AI explanation may only explain (provider.ts validates that).
 */
import type { EngineeringContext } from './context.js';

export type Severity = 'error' | 'warning' | 'info';
export type Certainty = 'verified' | 'conservative' | 'indeterminate';
export type FindingSource =
  'check' | 'solver' | 'rating' | 'build' | 'runtime' | 'capability' | 'analysis';

export type Family =
  | 'floating_input'
  | 'connection'
  | 'supply'
  | 'current_limit'
  | 'rating'
  | 'gpio_drive'
  | 'i2c'
  | 'logic'
  | 'capability'
  | 'build'
  | 'runtime'
  | 'model_limit'
  | 'analysis';

export type ActionId =
  | 'add_pull_resistor'
  | 'connect_terminal'
  | 'fix_wire_overlap'
  | 'connect_ground'
  | 'remove_short'
  | 'add_load'
  | 'increase_series_resistance'
  | 'reduce_stress'
  | 'lower_i2c_clock'
  | 'write_only_display'
  | 'remove_unsupported_feature'
  | 'fix_compile_error'
  | 'build_program'
  | 'run_simulation'
  | 'use_supported_value'
  | 'review_supply'
  | 'drive_defined_level'
  | 'retry_later';

export type LimitationId =
  | 'static_analysis'
  | 'dc_only'
  | 'datasheet_limit'
  | 'operating_range'
  | 'extrapolated'
  | 'no_operating_point'
  | 'scope_limited'
  | 'model_unknown'
  | 'not_a_circuit_fault'
  | 'unmodelled_behaviour';

interface Definition {
  family: Family;
  action?: ActionId;
  limitations?: LimitationId[];
  severity?: Severity;
}

/**
 * Every diagnostic the debugger can report, by stable id (`<family-area>.<condition>`). An id is
 * never renamed or reused; a test pins this list.
 */
export const DIAGNOSTICS = {
  // Editor checks (domain checks.ts).
  'connection.not_connected': { family: 'connection', action: 'connect_terminal' },
  'connection.partially_wired': { family: 'connection', action: 'connect_terminal' },
  'connection.wire_over_terminal': { family: 'connection', action: 'fix_wire_overlap' },
  'connection.terminals_touching': { family: 'connection', action: 'fix_wire_overlap' },
  'connection.floating_island': { family: 'connection', action: 'connect_ground' },
  'connection.empty_circuit': { family: 'connection', action: 'connect_terminal' },
  'supply.no_ground': { family: 'supply', action: 'connect_ground' },
  'supply.shorted': { family: 'supply', action: 'remove_short' },
  'supply.part_supply_shorted': { family: 'supply', action: 'remove_short' },
  'supply.no_load': { family: 'supply', action: 'add_load' },
  'gpio.input_floating': { family: 'floating_input', action: 'add_pull_resistor' },
  'gpio.input_unconnected': { family: 'floating_input', action: 'add_pull_resistor' },
  // Engine refusals (engine session.ts EngineErrorCode).
  'gpio.input_undefined': { family: 'floating_input', action: 'drive_defined_level' },
  'gpio.sensor_level_undefined': { family: 'floating_input', action: 'drive_defined_level' },
  'i2c.clock_exceeded': { family: 'i2c', action: 'lower_i2c_clock' },
  'i2c.read_unsupported': { family: 'i2c', action: 'write_only_display' },
  'supply.sinking': { family: 'supply', action: 'review_supply' },
  'supply.parallel': { family: 'supply', action: 'review_supply' },
  'solver.invalid_parameter': { family: 'model_limit', action: 'use_supported_value' },
  'solver.unsupported_component': { family: 'capability', action: 'remove_unsupported_feature' },
  'solver.no_steady_state': { family: 'model_limit', limitations: ['dc_only'] },
  'solver.not_solved': { family: 'model_limit', limitations: ['model_unknown'] },
  'logic.input_floating': { family: 'floating_input', action: 'add_pull_resistor' },
  'logic.supply_missing': { family: 'logic', action: 'connect_terminal' },
  'logic.not_characterized': {
    family: 'logic',
    action: 'drive_defined_level',
    limitations: ['datasheet_limit'],
  },
  // Rating rows (engine ratings.ts RatingCode).
  'current.led_overcurrent': {
    family: 'current_limit',
    action: 'increase_series_resistance',
    limitations: ['datasheet_limit', 'dc_only'],
  },
  'current.part_overcurrent': {
    family: 'current_limit',
    action: 'increase_series_resistance',
    limitations: ['datasheet_limit', 'dc_only'],
  },
  'rating.power': { family: 'rating', action: 'reduce_stress', limitations: ['datasheet_limit'] },
  'rating.voltage': { family: 'rating', action: 'reduce_stress', limitations: ['datasheet_limit'] },
  'rating.reverse_voltage': {
    family: 'rating',
    action: 'reduce_stress',
    limitations: ['datasheet_limit'],
  },
  'rating.outside_series': { family: 'rating', action: 'use_supported_value' },
  'rating.track_current': {
    family: 'rating',
    action: 'increase_series_resistance',
    limitations: ['datasheet_limit'],
  },
  'gpio.drive_current': {
    family: 'gpio_drive',
    action: 'increase_series_resistance',
    limitations: ['datasheet_limit'],
  },
  'gpio.cumulative_current': {
    family: 'gpio_drive',
    action: 'increase_series_resistance',
    limitations: ['datasheet_limit'],
  },
  'gpio.contention': { family: 'gpio_drive', action: 'remove_short' },
  'gpio.short': { family: 'gpio_drive', action: 'remove_short' },
  'gpio.overvoltage': {
    family: 'gpio_drive',
    action: 'reduce_stress',
    limitations: ['datasheet_limit'],
  },
  // Program and runtime capability.
  'capability.unsupported_feature': {
    family: 'capability',
    action: 'remove_unsupported_feature',
    limitations: ['unmodelled_behaviour'],
  },
  'capability.unsupported_part': { family: 'capability', action: 'remove_unsupported_feature' },
  'capability.runtime_missing': { family: 'capability', limitations: ['unmodelled_behaviour'] },
  'capability.board_plan': { family: 'capability', action: 'connect_terminal' },
  'capability.unmodelled_use': {
    family: 'capability',
    action: 'remove_unsupported_feature',
    limitations: ['unmodelled_behaviour'],
  },
  'pwm.unsupported': { family: 'capability', limitations: ['unmodelled_behaviour'] },
  'build.compile_error': { family: 'build', action: 'fix_compile_error' },
  'build.failed': { family: 'build', action: 'fix_compile_error' },
  'build.not_current': { family: 'build', action: 'build_program', severity: 'info' },
  'runtime.service': {
    family: 'runtime',
    action: 'retry_later',
    limitations: ['not_a_circuit_fault'],
  },
  'runtime.firmware_ended': { family: 'runtime', limitations: ['not_a_circuit_fault'] },
  // Analysis state.
  'analysis.no_operating_point': {
    family: 'analysis',
    action: 'run_simulation',
    limitations: ['no_operating_point'],
    severity: 'info',
  },
  'analysis.unknown_values': {
    family: 'analysis',
    limitations: ['model_unknown'],
    severity: 'info',
  },
  'analysis.no_issue_found': {
    family: 'analysis',
    limitations: ['scope_limited'],
    severity: 'info',
  },
} as const satisfies Record<string, Definition>;

export type DiagnosticId = keyof typeof DIAGNOSTICS;

export interface Finding {
  /** Unique within one analysis: `<id>#<n>`. */
  key: string;
  id: DiagnosticId;
  family: Family;
  severity: Severity;
  certainty: Certainty;
  source: FindingSource;
  components: string[];
  pins: number[];
  nets: string[];
  /** Context references this finding rests on (contextRefs). Never empty. */
  evidence: string[];
  action?: ActionId;
  limitations: LimitationId[];
  /** The record's own code (check, engine, rating, runtime or feature code): language-neutral. */
  code: string;
  /** Values the explanation may use, each from the cited evidence (numbers keep SI units). */
  facts: Record<string, string | number>;
}

const CHECK_IDS: Record<string, DiagnosticId> = {
  not_connected: 'connection.not_connected',
  partially_wired: 'connection.partially_wired',
  wire_over_terminal: 'connection.wire_over_terminal',
  terminals_touching: 'connection.terminals_touching',
  floating_island: 'connection.floating_island',
  no_ground: 'supply.no_ground',
  psu_shorted_by_wire: 'supply.shorted',
  supply_pins_shorted: 'supply.part_supply_shorted',
  psu_no_load: 'supply.no_load',
  gpio_input_floating: 'gpio.input_floating',
  gpio_input_unconnected: 'gpio.input_unconnected',
};

function engineId(code: string): DiagnosticId {
  switch (code) {
    case 'gpio_input_undefined':
      return 'gpio.input_undefined';
    case 'sensor_level_undefined':
      return 'gpio.sensor_level_undefined';
    case 'i2c_clock_exceeded':
      return 'i2c.clock_exceeded';
    case 'i2c_read_unsupported':
      return 'i2c.read_unsupported';
    case 'psu_shorted':
      return 'supply.shorted';
    case 'psu_sinking':
      return 'supply.sinking';
    case 'psu_parallel':
      return 'supply.parallel';
    case 'no_ground':
      return 'supply.no_ground';
    case 'floating_circuit':
      return 'connection.floating_island';
    case 'empty_circuit':
      return 'connection.empty_circuit';
    case 'invalid_parameter':
      return 'solver.invalid_parameter';
    case 'unsupported_component':
      return 'solver.unsupported_component';
    case 'no_steady_state':
      return 'solver.no_steady_state';
    case 'logic_input_floating':
      return 'logic.input_floating';
    case 'logic_supply_missing':
    case 'logic_supply_undriven':
      return 'logic.supply_missing';
    default:
      return code.startsWith('logic_') ? 'logic.not_characterized' : 'solver.not_solved';
  }
}

function ratingId(code: string, component: string, ctx: EngineeringContext): DiagnosticId {
  const type = ctx.circuit.components.find((c) => c.id === component)?.type ?? '';
  switch (code) {
    case 'forward_current':
      return type.includes('led') ? 'current.led_overcurrent' : 'current.part_overcurrent';
    case 'current':
      return 'current.part_overcurrent';
    case 'power':
      return 'rating.power';
    case 'voltage':
      return 'rating.voltage';
    case 'reverse_voltage':
      return 'rating.reverse_voltage';
    case 'resistance_outside_series':
      return 'rating.outside_series';
    case 'track_current':
      return 'rating.track_current';
    case 'gpio_source_current':
    case 'gpio_sink_current':
      return 'gpio.drive_current';
    case 'gpio_cumulative_current':
      return 'gpio.cumulative_current';
    case 'gpio_contention':
      return 'gpio.contention';
    case 'gpio_short_ground':
    case 'gpio_short_supply':
      return 'gpio.short';
    default:
      return 'gpio.overvoltage';
  }
}

const RUNTIME_SERVICE = new Set([
  'session_create_failed',
  'runtime_busy',
  'session_quota',
  'rate_limited',
  'firmware_unavailable',
  'session_lost',
  'session_expired',
  'protocol_error',
  'commands_rate_limited',
  'startup_failed',
  'runtime_crashed',
  'mirror_failed',
  'timeout',
  'worker_crashed',
]);

/** Why the app refused to start an ESP32 session (app runtime/snapshot.ts McuPlanError). */
const MCU_IDS: Record<string, DiagnosticId> = {
  mcu_unsupported_features: 'capability.unsupported_feature',
  mcu_component_unsupported: 'capability.unsupported_part',
  mcu_component_time_dependent: 'capability.unsupported_part',
  mcu_build_required: 'build.not_current',
  mcu_no_program: 'build.not_current',
  mcu_ground_unconnected: 'supply.no_ground',
  mcu_pin_without_circuit: 'connection.not_connected',
};

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** Run the debugger over a context. Deterministic and pure. */
export function diagnose(ctx: EngineeringContext): Finding[] {
  const out: Omit<Finding, 'key'>[] = [];
  const push = (
    id: DiagnosticId,
    f: Partial<Omit<Finding, 'key' | 'id' | 'family' | 'action' | 'limitations'>> & {
      evidence: string[];
      source: FindingSource;
      code: string;
    },
    extraLimits: LimitationId[] = [],
  ) => {
    const def: Definition = DIAGNOSTICS[id];
    out.push({
      id,
      family: def.family,
      severity: f.severity ?? def.severity ?? 'warning',
      certainty: f.certainty ?? 'verified',
      source: f.source,
      components: f.components ?? [],
      pins: f.pins ?? [],
      nets: f.nets ?? [],
      evidence: f.evidence,
      ...(def.action ? { action: def.action } : {}),
      limitations: [...new Set([...(def.limitations ?? []), ...extraLimits])],
      code: f.code,
      facts: f.facts ?? {},
    });
  };
  const gpioOf = (terminals: readonly string[] | undefined) =>
    (terminals ?? []).filter((t) => /^gpio\d+$/.test(t)).map((t) => Number(t.slice(4)));

  // 1. Editor checks: conservative, before Run.
  for (const c of ctx.checks) {
    const id = CHECK_IDS[c.code];
    if (!id) continue;
    const pins = gpioOf(c.terminals);
    push(
      id,
      {
        source: 'check',
        code: c.code,
        severity: c.severity === 'warning' ? 'warning' : 'info',
        certainty: 'conservative',
        components: c.components,
        pins,
        evidence: [
          c.ref,
          ...ctx.excerpts.filter((e) => pins.some((p) => e.why === `gpio:${p}`)).map((e) => e.ref),
        ],
        facts: { ...(pins[0] !== undefined ? { gpio: pins[0] } : {}) },
      },
      ['static_analysis'],
    );
  }

  // 2. The engine's refusal of the run.
  const e = ctx.solver.error;
  if (e) {
    const id = engineId(e.code);
    const pins = Object.entries(e.detail)
      .filter(([k, v]) => (k === 'gpio' || /^inputs\.\d+\.gpio$/.test(k)) && typeof v === 'number')
      .map(([, v]) => v as number);
    const facts: Finding['facts'] = {};
    for (const [k, v] of Object.entries(e.detail))
      if (typeof v === 'number' || typeof v === 'string') facts[k] = v;
    push(id, {
      source: 'solver',
      code: e.code,
      severity: 'error',
      components: e.components,
      nets: e.nets,
      pins,
      evidence: [
        e.ref,
        ...ctx.excerpts.filter((x) => pins.some((p) => x.why === `gpio:${p}`)).map((x) => x.ref),
      ],
      facts,
      ...(id === 'solver.not_solved' ? { certainty: 'indeterminate' as const } : {}),
    });
  }

  // 3. Rating rows of the solved operating point.
  for (const r of ctx.ratings) {
    const id = ratingId(r.code, r.component, ctx);
    const facts: Finding['facts'] = { limit: r.limit.value, unit: r.limit.unit };
    if (r.value) facts.value = r.value.value;
    if (r.gpio !== undefined) facts.gpio = r.gpio;
    if (r.otherGpio !== undefined) facts.otherGpio = r.otherGpio;
    push(
      id,
      {
        source: 'rating',
        code: r.code,
        severity: r.kind === 'absolute' ? 'error' : 'warning',
        components: [r.component],
        pins: [r.gpio, r.otherGpio].filter((g): g is number => g !== undefined),
        evidence: [
          r.ref,
          ...(ctx.solver.components?.some((c) => c.id === r.component)
            ? [`result:${r.component}`]
            : []),
        ],
        facts,
      },
      [
        ...(r.value ? [] : (['extrapolated'] as const)),
        ...(r.kind === 'absolute' ? [] : (['operating_range'] as const)),
      ],
    );
  }

  // 4. Why a run could not start or ended (not the engine).
  const f = ctx.failure;
  if (f) {
    if (f.kind === 'mcu') {
      const id: DiagnosticId = MCU_IDS[f.code] ?? 'capability.board_plan';
      push(id, {
        source: 'capability',
        code: f.code,
        severity: 'error',
        components: f.components,
        pins: f.pins,
        evidence: [f.ref],
        facts: f.features.length ? { features: f.features.join(',') } : {},
      });
    } else if (f.kind === 'unmodelled') {
      push('capability.unmodelled_use', {
        source: 'capability',
        code: f.code,
        severity: 'error',
        evidence: [f.ref],
        facts: f.facility ? { facility: f.facility } : {},
      });
    } else if (f.kind === 'pwm') {
      push('pwm.unsupported', {
        source: 'runtime',
        code: f.code,
        severity: 'error',
        components: f.components,
        pins: f.pins,
        evidence: [f.ref],
      });
    } else if (f.kind === 'runtime' && f.code === 'unsupported_feature') {
      push('capability.unsupported_feature', {
        source: 'runtime',
        code: f.code,
        severity: 'error',
        evidence: [f.ref],
      });
    } else {
      push(RUNTIME_SERVICE.has(f.code) ? 'runtime.service' : 'runtime.firmware_ended', {
        source: 'runtime',
        code: f.code,
        severity: 'warning',
        evidence: [f.ref],
      });
    }
  }

  // 5. The build: compile errors at their file and line; facilities the simulator does not model.
  const b = ctx.build;
  if (b) {
    const errors = b.diagnostics.filter((d) => d.severity === 'error');
    for (const d of errors.slice(0, 5))
      push('build.compile_error', {
        source: 'build',
        code: 'compile_error',
        severity: 'error',
        evidence: [d.ref, ...ctx.excerpts.filter((x) => x.why === d.ref).map((x) => x.ref)],
        facts: {
          ...(d.file ? { file: d.file } : {}),
          ...(d.line !== undefined ? { line: d.line } : {}),
        },
      });
    if (b.status === 'failed' && errors.length === 0)
      push('build.failed', {
        source: 'build',
        code: 'build_failed',
        severity: 'error',
        evidence: ['build'],
      });
    for (const u of b.unsupported)
      push('capability.unsupported_feature', {
        source: 'build',
        code: u,
        severity: 'error',
        evidence: ['build'],
        facts: { feature: u },
      });
    for (const r of b.requires)
      if (ctx.capabilities.runtime && !ctx.capabilities.runtime.includes(r))
        push('capability.runtime_missing', {
          source: 'build',
          code: r,
          severity: 'error',
          evidence: ['build', 'capabilities'],
          facts: { capability: r },
        });
  }
  if (ctx.program && (!b || b.status === 'none' || b.status === 'stale') && !f)
    push('build.not_current', {
      source: 'analysis',
      code: b?.status ?? 'none',
      evidence: ['program'],
    });

  // 6. What the product could not establish.
  if (ctx.solver.status === 'not_run' && !e && !f)
    push('analysis.no_operating_point', {
      source: 'analysis',
      code: 'not_run',
      certainty: 'indeterminate',
      evidence: ctx.unknowns.filter((u) => u.what === 'operating_point').map((u) => u.ref),
    });
  const unknown = ctx.unknowns.filter((u) => u.what !== 'operating_point');
  if (unknown.length)
    push('analysis.unknown_values', {
      source: 'analysis',
      code: 'unknown',
      certainty: 'indeterminate',
      components: unknown
        .filter((u) => u.what.startsWith('component:'))
        .map((u) => u.what.slice(10)),
      pins: unknown.filter((u) => u.what.startsWith('gpio:')).map((u) => Number(u.what.slice(5))),
      evidence: unknown.map((u) => u.ref),
    });
  if (!out.some((x) => x.severity !== 'info') && ctx.solver.status === 'ok')
    push('analysis.no_issue_found', {
      source: 'analysis',
      code: 'none',
      certainty: 'conservative',
      evidence: ['capabilities', ...ctx.checks.map((c) => c.ref)].slice(0, 8),
    });

  // Most severe first; otherwise in the order above (stable).
  const sorted = out
    .map((x, i) => ({ x, i }))
    .sort((a, b) => SEVERITY_ORDER[a.x.severity] - SEVERITY_ORDER[b.x.severity] || a.i - b.i)
    .map(({ x }) => x);
  const n = new Map<string, number>();
  return sorted.map((x) => {
    const k = (n.get(x.id) ?? 0) + 1;
    n.set(x.id, k);
    return { key: `${x.id}#${k}`, ...x };
  });
}

/**
 * Sprint 27 Phase 1: the Engineering Context API. A versioned, bounded, language-neutral account
 * of the open project and what the product already knows about it, built ONLY from the project
 * document and the findings the product's verified layers produced (editor checks, the electrical
 * engine's outcome and rating checks, the build service's diagnostics and feature report, the
 * runtime's failure and observed pad levels). Nothing here computes physics; nothing is estimated.
 *
 * Every number carries its provenance:
 * - `specified`: a value stored in the project (a part's parameter as the user set it);
 * - `datasheet`: a documented limit of a modelled part (a rating, a threshold);
 * - `calculated`: the electrical engine's solved operating point;
 * - `observed`: reported by the running firmware session (a pad's mode or level);
 * - `assumed`: a stated modelling assumption of the product (never a guessed value);
 * - `unknown`: the product has no defensible value (an unsolved or undefined quantity: absent
 *   value, with the reason).
 *
 * Data minimisation: no project name, no user-authored net names, no identities, no serial output.
 * Source code appears only as bounded excerpts at the lines a diagnostic or a finding points to,
 * with comments removed and marked untrusted (it may contain text addressed to a model).
 */
import {
  CATALOG,
  FIRMWARE_FACILITIES,
  SCHEMA_VERSION,
  programInputReads,
  type CheckIssue,
  type ProjectDocument,
  type UnitId,
} from '@tbi-lab/domain';
import {
  ENGINE_VERSION,
  RATING_UNIT,
  type EngineError,
  type RatingWarning,
  type SolveOutcome,
} from '@tbi-lab/engine';
import { maskComments, redactSecrets } from './redact.js';

/** C0 control characters except tab and newline, and DEL (built from code points: lint-clean). */
const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
);

export const CONTEXT_FORMAT = 'tbi-lab.engineering-context';
export const CONTEXT_VERSION = 1;

/** Hard bounds of one context (and of what a provider may be sent). */
export const CONTEXT_LIMITS = {
  /** Serialized JSON, UTF-8 bytes. Over it: details dropped (recorded), then refused. */
  maxBytes: 48 * 1024,
  maxComponents: 120,
  maxNets: 200,
  maxChecks: 60,
  maxRatings: 60,
  maxBuildDiagnostics: 20,
  maxDiagnosticChars: 240,
  maxExcerpts: 8,
  /** Lines of context on each side of the line an excerpt is about. */
  excerptRadius: 2,
  maxExcerptLineChars: 160,
} as const;

export type Provenance =
  'specified' | 'datasheet' | 'calculated' | 'observed' | 'assumed' | 'unknown';

/** SI symbols of the project's canonical units (values are stored in these units). */
export const SI_SYMBOL: Readonly<Record<UnitId, string>> = {
  ohm: 'Ω',
  volt: 'V',
  ampere: 'A',
  lux: 'lx',
  farad: 'F',
  metre: 'm',
  celsius: '°C',
  percent_rh: '%RH',
  percent: '%',
};

export interface Value {
  value: number;
  unit: string;
  provenance: Provenance;
}

export interface ContextParam {
  key: string;
  /** A quantity in SI, a boolean setting or a language-neutral enum token. */
  value: Value | boolean | string;
}

export interface ContextComponent {
  id: string;
  type: string;
  typeVersion: number;
  params: ContextParam[];
  /** Every terminal of the type, with its net (null: not connected). */
  terminals: { id: string; net: string | null }[];
}

export interface ContextNet {
  id: string;
  ground: boolean;
  /** `component:terminal` of every member. */
  pins: string[];
}

export interface ContextCheck {
  ref: string;
  code: string;
  severity: 'info' | 'warning';
  components: string[];
  terminals?: string[];
}

export interface ContextSolverError {
  ref: string;
  code: string;
  components: string[];
  nets: string[];
  param?: string;
  /** Numeric and short token details of the engine's refusal (numbers keep the engine's unit). */
  detail: Record<string, number | string | number[] | boolean>;
}

export interface ContextComponentResult {
  ref: string;
  id: string;
  current?: Value;
  voltage?: Value;
  /** The engine marked the result unknown (no defensible value): no number is given. */
  unknown?: true;
  outsideModelRange?: true;
}

export interface ContextPinResult {
  ref: string;
  gpio: number;
  mode: string;
  voltage?: Value;
  current?: Value;
  levelUndefined?: string;
  outsideModelRange?: true;
}

export interface ContextSolver {
  status: 'not_run' | 'ok' | 'failed';
  engineVersion: string;
  error?: ContextSolverError;
  netVoltages?: { ref: string; net: string; voltage: Value }[];
  components?: ContextComponentResult[];
  pins?: ContextPinResult[];
  unknownNets?: string[];
  notConnected?: string[];
}

export interface ContextRating {
  ref: string;
  component: string;
  code: string;
  kind: string;
  model: string;
  /** Absent when the engine marks the solved value an extrapolation (never shown as a value). */
  value?: Value;
  limit: Value;
  gpio?: number;
  otherGpio?: number;
  channel?: string;
}

export interface ContextBuildDiagnostic {
  ref: string;
  severity: string;
  file?: string;
  line?: number;
  column?: number;
  message: string;
}

export interface ContextBuild {
  status: 'none' | 'building' | 'current' | 'failed' | 'stale';
  diagnostics: ContextBuildDiagnostic[];
  /** Facilities the build found that the simulator does not model. */
  unsupported: string[];
  /** Runtime capabilities the firmware needs. */
  requires: string[];
  inputReads?: { pins: number[]; unresolved: boolean };
}

export interface ContextFailure {
  ref: string;
  kind: string;
  code: string;
  components: string[];
  pins: number[];
  features: string[];
  facility?: string;
}

export interface ContextProgram {
  board: string;
  language: string;
  profile: string;
  files: { path: string; lines: number; bytes: number }[];
  libraries: { id: string; version: string }[];
  /** Static analysis of digital reads (domain inputPins.ts: literal and simple-constant pins). */
  inputReads: { pins: number[]; unresolved: boolean };
}

export interface ContextExcerpt {
  ref: string;
  file: string;
  startLine: number;
  lines: string[];
  /** Always true: user code is data, never instructions. */
  untrusted: true;
  why: string;
}

export interface ContextUnknown {
  ref: string;
  what: string;
  why: string;
}

export interface EngineeringContext {
  format: typeof CONTEXT_FORMAT;
  version: typeof CONTEXT_VERSION;
  product: { schemaVersion: number; engineVersion: string };
  circuit: { components: ContextComponent[]; nets: ContextNet[] };
  checks: ContextCheck[];
  solver: ContextSolver;
  ratings: ContextRating[];
  program?: ContextProgram;
  build?: ContextBuild;
  failure?: ContextFailure;
  observed?: { ref: string; gpio: number; mode?: string; level?: number }[];
  capabilities: {
    /** The runtime's announced capabilities; null: not known to the caller (never assumed). */
    runtime: string[] | null;
    facilities: { id: string; status: string }[];
  };
  /** Stated modelling assumptions in force (ids; the product's own documented contract). */
  assumptions: string[];
  excerpts: ContextExcerpt[];
  unknowns: ContextUnknown[];
  /** What was left out to respect the bounds (never silently). */
  truncated: string[];
}

/** A failure as the app holds it (structurally its SimFailure; no app types here). */
export type FailureInput =
  | { kind: 'engine'; error: EngineError }
  | { kind: 'worker'; code: string }
  | { kind: 'mcu'; code: string; components: string[]; pins?: number[]; features?: string[] }
  | { kind: 'runtime'; code: string }
  | { kind: 'unmodelled'; code: string; facility: string }
  | { kind: 'pwm'; code: string; gpios: number[]; components?: string[]; inputs?: number[] };

export interface BuildInput {
  status: ContextBuild['status'];
  diagnostics?: readonly {
    severity: string;
    file?: string;
    line?: number;
    column?: number;
    message: string;
  }[];
  features?: {
    unsupported?: readonly string[];
    requires?: readonly string[];
    inputReads?: { pins: number[]; unresolved: boolean };
  };
}

export interface ContextInput {
  doc: ProjectDocument;
  /** domain checkCircuit(doc). */
  checks: readonly CheckIssue[];
  /** The latest outcome of a running simulation (null: not running). */
  outcome?: SolveOutcome | null;
  /** The engine's rating check of that outcome (app warningsFor / engine ratingWarnings). */
  ratings?: readonly RatingWarning[];
  /** Why the last run failed (null: it did not). */
  failure?: FailureInput | null;
  build?: BuildInput | null;
  /** Pad modes/levels the running firmware reported (runtime view), if any. */
  observed?: Readonly<Record<number, { mode?: string; level?: number }>> | null;
  /** The runtime capabilities the deployment announces; absent: not known (no check is made). */
  runtimeCapabilities?: readonly string[] | null;
}

export type ContextResult =
  | { ok: true; context: EngineeringContext; bytes: number }
  | { ok: false; error: 'context_too_large'; bytes: number };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const val = (value: number, unit: string, provenance: Provenance): Value => ({
  value,
  unit,
  provenance,
});
const RATING_SI: Record<string, string> = { ampere: 'A', volt: 'V', watt: 'W', ohm: 'Ω' };

/** Engine error details reduced to numbers and short tokens (never free text or objects). */
function detailOf(d: Record<string, unknown> | undefined): ContextSolverError['detail'] {
  const out: ContextSolverError['detail'] = {};
  for (const [k, v] of Object.entries(d ?? {})) {
    if (isNum(v) || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && /^[\w.:-]{1,48}$/.test(v)) out[k] = v;
    else if (Array.isArray(v) && v.length <= 32 && v.every(isNum)) out[k] = v;
    else if (k === 'inputs' && Array.isArray(v))
      // gpio_input_undefined: each pad and why (numbers and cause tokens only).
      v.slice(0, 16).forEach((i: unknown, n) => {
        const x = i as { gpio?: unknown; cause?: unknown; voltage?: unknown };
        if (isNum(x.gpio)) out[`inputs.${n}.gpio`] = x.gpio;
        if (typeof x.cause === 'string' && /^\w{1,32}$/.test(x.cause))
          out[`inputs.${n}.cause`] = x.cause;
        if (isNum(x.voltage)) out[`inputs.${n}.voltage`] = x.voltage;
      });
  }
  return out;
}

/** Compiler text bounded and stripped of anything path-like outside the project's own files. */
function cleanMessage(message: string): string {
  return message
    .replace(/(?:\/[\w.@+-]+){2,}\/?/g, '…')
    .replace(new RegExp(CONTROL_CHARS.source, 'g'), '')
    .slice(0, CONTEXT_LIMITS.maxDiagnosticChars);
}

function programFiles(doc: ProjectDocument, board: string): { path: string; text: string }[] {
  const p = doc.programs[board];
  if (!p) return [];
  return [{ path: p.fileName, text: p.text }, ...(p.files ?? [])];
}

/** A bounded excerpt of `file` around `line` (1-based), comments removed. */
function excerpt(
  doc: ProjectDocument,
  board: string,
  file: string,
  line: number,
  why: string,
  ref: string,
): ContextExcerpt | null {
  const p = doc.programs[board];
  const f = programFiles(doc, board).find((x) => x.path === file);
  if (!p || !f || !Number.isInteger(line) || line < 1) return null;
  const all = maskComments(f.text, p.language).split('\n');
  if (line > all.length) return null;
  const r = CONTEXT_LIMITS.excerptRadius;
  const start = Math.max(1, line - r);
  const lines = all
    .slice(start - 1, Math.min(all.length, line + r))
    .map((l) => redactSecrets(l).slice(0, CONTEXT_LIMITS.maxExcerptLineChars));
  return { ref, file, startLine: start, lines, untrusted: true, why };
}

/** Lines of the board's program that read `gpio` (pinMode/digitalRead/Pin(...)): 1-based. */
function readLines(
  doc: ProjectDocument,
  board: string,
  gpio: number,
): { file: string; line: number }[] {
  const p = doc.programs[board];
  if (!p) return [];
  const re =
    p.language === 'micropython'
      ? new RegExp(`\\bPin\\s*\\(\\s*${gpio}\\b`)
      : new RegExp(
          `\\b(?:pinMode|digitalRead|attachInterrupt)\\s*\\(\\s*(?:digitalPinToInterrupt\\s*\\(\\s*)?${gpio}\\b`,
        );
  const out: { file: string; line: number }[] = [];
  for (const f of programFiles(doc, board)) {
    maskComments(f.text, p.language)
      .split('\n')
      .forEach((l, i) => {
        if (re.test(l)) out.push({ file: f.path, line: i + 1 });
      });
  }
  return out;
}

const boardOf = (doc: ProjectDocument): string | undefined =>
  Object.keys(doc.programs)[0] ??
  doc.components.find((c) => CATALOG[c.type].symbol === 'board' || c.type.startsWith('board.'))?.id;

/** Build the context. Deterministic: the same inputs give the same JSON, byte for byte. */
export function buildEngineeringContext(input: ContextInput): ContextResult {
  const { doc } = input;
  const L = CONTEXT_LIMITS;
  const truncated: string[] = [];
  const cap = <T>(list: readonly T[], max: number, what: string): T[] => {
    if (list.length > max) truncated.push(`${what}:${list.length - max}`);
    return list.slice(0, max);
  };

  // Circuit: parts, their parameters (SI, as specified) and every terminal's net.
  const netOf = new Map(doc.connections.map((c) => [`${c.component}:${c.terminal}`, c.net]));
  const components: ContextComponent[] = cap(doc.components, L.maxComponents, 'components').map(
    (c) => {
      const def = CATALOG[c.type];
      const params: ContextParam[] = def.params
        .filter((p) => c.params[p.key] !== undefined)
        .map((p) => {
          const v = c.params[p.key]!;
          return {
            key: p.key,
            value:
              typeof v === 'object' ? val(v.value, SI_SYMBOL[v.unit] ?? v.unit, 'specified') : v,
          };
        });
      return {
        id: c.id,
        type: c.type,
        typeVersion: c.typeVersion,
        params,
        terminals: def.terminals.map((t) => ({
          id: t.id,
          net: netOf.get(`${c.id}:${t.id}`) ?? null,
        })),
      };
    },
  );
  const members = new Map<string, string[]>();
  for (const c of doc.connections)
    members.set(c.net, [...(members.get(c.net) ?? []), `${c.component}:${c.terminal}`]);
  const nets: ContextNet[] = cap(doc.nets, L.maxNets, 'nets').map((n) => ({
    id: n.id,
    ground: n.role === 'ground',
    pins: members.get(n.id) ?? [],
  }));

  const checks: ContextCheck[] = cap(input.checks, L.maxChecks, 'checks').map((c, i) => ({
    ref: `check:${i}`,
    code: c.code,
    severity: c.severity,
    components: [...c.components],
    ...(c.terminals ? { terminals: [...c.terminals] } : {}),
  }));

  // Solver: the engine's outcome as given (never re-solved here).
  const unknowns: ContextUnknown[] = [];
  const out = input.outcome ?? null;
  let solver: ContextSolver;
  const engineFailure = input.failure?.kind === 'engine' ? input.failure.error : null;
  if (engineFailure) {
    solver = {
      status: 'failed',
      engineVersion: ENGINE_VERSION,
      error: {
        ref: 'solver:error',
        code: engineFailure.code,
        components: [...(engineFailure.components ?? [])],
        nets: [...(engineFailure.nets ?? [])],
        ...(engineFailure.param ? { param: engineFailure.param } : {}),
        detail: detailOf(engineFailure.detail),
      },
    };
  } else if (out && out.ok) {
    const comps: ContextComponentResult[] = Object.values(out.components).map((r, i) => {
      const ref = `result:${r.id}`;
      if (r.unknown)
        unknowns.push({ ref: `unknown:${i}`, what: `component:${r.id}`, why: 'engine_unknown' });
      return {
        ref,
        id: r.id,
        ...(!r.unknown && isNum(r.current) ? { current: val(r.current, 'A', 'calculated') } : {}),
        ...(!r.unknown && isNum(r.voltage) ? { voltage: val(r.voltage, 'V', 'calculated') } : {}),
        ...(r.unknown ? { unknown: true as const } : {}),
        ...(r.outsideModelRange ? { outsideModelRange: true as const } : {}),
      };
    });
    const pins: ContextPinResult[] = (out.pins ?? []).map((p) => {
      if (p.levelUndefined)
        unknowns.push({
          ref: `unknown:pin${p.gpio}`,
          what: `gpio:${p.gpio}`,
          why: `level_${p.levelUndefined}`,
        });
      return {
        ref: `pin:${p.gpio}`,
        gpio: p.gpio,
        mode: p.mode,
        ...(isNum(p.voltage) && !p.levelUndefined
          ? { voltage: val(p.voltage, 'V', 'calculated') }
          : {}),
        ...(isNum(p.current) && !p.outsideModelRange
          ? { current: val(p.current, 'A', 'calculated') }
          : {}),
        ...(p.levelUndefined ? { levelUndefined: p.levelUndefined } : {}),
        ...(p.outsideModelRange ? { outsideModelRange: true as const } : {}),
      };
    });
    for (const n of out.unknownNets ?? [])
      unknowns.push({ ref: `unknown:net:${n}`, what: `net:${n}`, why: 'engine_unknown' });
    solver = {
      status: 'ok',
      engineVersion: out.engineVersion,
      netVoltages: Object.entries(out.netVoltages)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([net, v]) => ({ ref: `net:${net}`, net, voltage: val(v, 'V', 'calculated') })),
      components: comps,
      ...(pins.length ? { pins } : {}),
      ...(out.unknownNets?.length ? { unknownNets: [...out.unknownNets] } : {}),
      ...(out.notConnected.length ? { notConnected: [...out.notConnected] } : {}),
    };
  } else {
    solver = { status: 'not_run', engineVersion: ENGINE_VERSION };
    unknowns.push({ ref: 'unknown:operating_point', what: 'operating_point', why: 'not_run' });
  }

  const ratings: ContextRating[] = cap(input.ratings ?? [], L.maxRatings, 'ratings').map((w, i) => {
    const unit = RATING_SI[RATING_UNIT[w.code]] ?? '';
    return {
      ref: `rating:${i}`,
      component: w.component,
      code: w.code,
      kind: w.kind,
      model: w.model,
      ...(w.unreliable ? {} : { value: val(w.value, unit, 'calculated') }),
      limit: val(w.limit, unit, 'datasheet'),
      ...(w.gpio !== undefined ? { gpio: w.gpio } : {}),
      ...(w.otherGpio !== undefined ? { otherGpio: w.otherGpio } : {}),
      ...(w.channel ? { channel: w.channel } : {}),
    };
  });

  // Program, build and runtime (the board that has the program).
  const board = boardOf(doc);
  const prog = board ? doc.programs[board] : undefined;
  let program: ContextProgram | undefined;
  if (board && prog)
    program = {
      board,
      language: prog.language,
      profile: prog.profile,
      files: programFiles(doc, board).map((f) => ({
        path: f.path,
        lines: f.text.split('\n').length,
        bytes: new TextEncoder().encode(f.text).length,
      })),
      libraries: (prog.libraries ?? []).map((l) => ({ id: l.id, version: l.version })),
      inputReads: programInputReads(prog),
    };
  let build: ContextBuild | undefined;
  const excerpts: ContextExcerpt[] = [];
  if (input.build) {
    const diags = cap(input.build.diagnostics ?? [], L.maxBuildDiagnostics, 'build_diagnostics');
    build = {
      status: input.build.status,
      diagnostics: diags.map((d, i) => ({
        ref: `build:${i}`,
        severity: d.severity,
        ...(d.file ? { file: d.file } : {}),
        ...(isNum(d.line) ? { line: d.line } : {}),
        ...(isNum(d.column) ? { column: d.column } : {}),
        message: cleanMessage(d.message),
      })),
      unsupported: [...(input.build.features?.unsupported ?? [])],
      requires: [...(input.build.features?.requires ?? [])],
      ...(input.build.features?.inputReads ? { inputReads: input.build.features.inputReads } : {}),
    };
    if (board)
      for (const d of build.diagnostics)
        if (d.file && d.line && d.severity === 'error') {
          const e = excerpt(doc, board, d.file, d.line, d.ref, `code:${excerpts.length}`);
          if (e) excerpts.push(e);
        }
  }
  let failure: ContextFailure | undefined;
  const f = input.failure;
  if (f && f.kind !== 'engine')
    failure = {
      ref: 'failure',
      kind: f.kind,
      code: f.code,
      components: f.kind === 'mcu' || f.kind === 'pwm' ? [...(f.components ?? [])] : [],
      pins: f.kind === 'mcu' ? [...(f.pins ?? [])] : f.kind === 'pwm' ? [...f.gpios] : [],
      features: f.kind === 'mcu' ? [...(f.features ?? [])] : [],
      ...(f.kind === 'unmodelled' ? { facility: f.facility } : {}),
    };
  // Excerpts where the program reads a pin a check or the runtime names as undefined/floating.
  if (board && prog) {
    const pinsOfInterest = new Set<number>();
    for (const c of input.checks)
      if (c.code === 'gpio_input_floating' || c.code === 'gpio_input_unconnected')
        for (const t of c.terminals ?? [])
          if (/^gpio\d+$/.test(t)) pinsOfInterest.add(Number(t.slice(4)));
    if (engineFailure?.code === 'gpio_input_undefined')
      for (const [k, v] of Object.entries(detailOf(engineFailure.detail)))
        if (/^inputs\.\d+\.gpio$/.test(k) && isNum(v)) pinsOfInterest.add(v);
    for (const g of [...pinsOfInterest].sort((a, b) => a - b))
      for (const at of readLines(doc, board, g).slice(0, 2)) {
        const e = excerpt(doc, board, at.file, at.line, `gpio:${g}`, `code:${excerpts.length}`);
        if (e) excerpts.push(e);
      }
  }

  const observed = input.observed
    ? Object.entries(input.observed)
        .map(([g, o]) => ({
          ref: `observed:${g}`,
          gpio: Number(g),
          ...(o.mode ? { mode: o.mode } : {}),
          ...(isNum(o.level) ? { level: o.level } : {}),
        }))
        .sort((a, b) => a.gpio - b.gpio)
    : undefined;

  const context: EngineeringContext = {
    format: CONTEXT_FORMAT,
    version: CONTEXT_VERSION,
    product: { schemaVersion: SCHEMA_VERSION, engineVersion: ENGINE_VERSION },
    circuit: { components, nets },
    checks,
    solver,
    ratings,
    ...(program ? { program } : {}),
    ...(build ? { build } : {}),
    ...(failure ? { failure } : {}),
    ...(observed?.length ? { observed } : {}),
    capabilities: {
      runtime: input.runtimeCapabilities ? [...input.runtimeCapabilities].sort() : null,
      facilities: FIRMWARE_FACILITIES.map((x) => ({ id: x.id, status: x.status })),
    },
    assumptions: ['dc_steady_state', 'ideal_wires', 'datasheet_typical_models'],
    excerpts: cap(excerpts, L.maxExcerpts, 'excerpts'),
    unknowns,
    truncated,
  };
  return bounded(context);
}

const size = (c: EngineeringContext) => new TextEncoder().encode(JSON.stringify(c)).length;

/** Enforce the byte bound: drop the bulkiest optional detail first, recorded; else refuse. */
function bounded(c: EngineeringContext): ContextResult {
  let bytes = size(c);
  const steps: [string, (x: EngineeringContext) => void][] = [
    ['excerpts', (x) => (x.excerpts = [])],
    ['net_voltages', (x) => delete x.solver.netVoltages],
    ['nets', (x) => (x.circuit.nets = [])],
    ['component_results', (x) => delete x.solver.components],
  ];
  for (const [what, drop] of steps) {
    if (bytes <= CONTEXT_LIMITS.maxBytes) break;
    drop(c);
    c.truncated.push(`${what}:all`);
    bytes = size(c);
  }
  return bytes <= CONTEXT_LIMITS.maxBytes
    ? { ok: true, context: c, bytes }
    : { ok: false, error: 'context_too_large', bytes };
}

/** Every evidence reference a context defines (findings and explanations may cite only these). */
export function contextRefs(c: EngineeringContext): Set<string> {
  const refs = new Set<string>();
  const add = (r: string | undefined) => r && refs.add(r);
  c.checks.forEach((x) => add(x.ref));
  add(c.solver.error?.ref);
  c.solver.netVoltages?.forEach((x) => add(x.ref));
  c.solver.components?.forEach((x) => add(x.ref));
  c.solver.pins?.forEach((x) => add(x.ref));
  c.ratings.forEach((x) => add(x.ref));
  c.build?.diagnostics.forEach((x) => add(x.ref));
  add(c.failure?.ref);
  c.observed?.forEach((x) => add(x.ref));
  c.excerpts.forEach((x) => add(x.ref));
  c.unknowns.forEach((x) => add(x.ref));
  for (const comp of c.circuit.components) add(`component:${comp.id}`);
  if (c.program) add('program');
  if (c.build) add('build');
  add('capabilities');
  return refs;
}

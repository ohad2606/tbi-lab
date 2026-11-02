/**
 * Sprint 27 Phase 5: the typed action protocol for later sprints (AI-assisted modifications). An
 * action is a proposal: it is validated against the catalog, the project schema, the editor's
 * electrical checks and the caller's permissions, and DRY-RUN on a copy of the project to show
 * what it would change. Nothing here applies an action to the user's project: there is no apply
 * function, and in Sprint 27 every AI-origin action is marked not applicable (`ai_write_disabled`)
 * whatever its validity. The user's project object is never mutated (the edit operations are pure).
 */
import {
  CATALOG,
  addComponent,
  addProgramFile,
  addWire,
  checkCircuit,
  cloneDocument,
  deleteSelection,
  getTypeDef,
  isComponentType,
  managedLibrary,
  placementBlock,
  programPathIssue,
  setParam,
  setProgramText,
  sortLibraryRefs,
  type CheckIssue,
  type ParamValue,
  type ProgramLanguage,
  type ProjectDocument,
  type UnitId,
} from '@tbi-lab/domain';

export const ACTION_PROTOCOL = 'tbi-lab.assist.action/1';
export const ACTION_LIMITS = {
  maxActions: 10,
  maxRationaleChars: 500,
  maxFileBytes: 64 * 1024,
} as const;

export interface TerminalRef {
  /** A component id, or `new:<n>`: the n-th component this envelope adds (0-based). */
  component: string;
  terminal: string;
}

export type ProposedAction =
  | { kind: 'add_component'; type: string; at?: { x: number; y: number } }
  | { kind: 'connect'; from: TerminalRef; to: TerminalRef }
  | { kind: 'disconnect'; from: TerminalRef; to: TerminalRef }
  | {
      kind: 'set_value';
      component: string;
      param: string;
      value: number | boolean | string;
      unit?: UnitId;
    }
  | { kind: 'write_file'; board: string; path: string; text: string }
  | { kind: 'select_library'; board: string; id: string; version: string }
  | { kind: 'request_validation'; what: 'build' | 'run' };

/**
 * Who proposes. Review S27-M4: set by the caller from where the envelope came from (a provider's
 * reply is always 'ai'), never read from the envelope, which a provider writes.
 */
export type ActionOrigin = 'ai' | 'user';

export interface ActionEnvelope {
  protocol: typeof ACTION_PROTOCOL;
  /** Plain-text reason, shown to the user; never executed. */
  rationale?: string;
  /** Evidence references the proposal rests on (context refs). */
  cites: string[];
  actions: ProposedAction[];
}

export interface ActionPermissions {
  /** May an AI-origin proposal be applied after the user approves it? Sprint 27: always false. */
  aiWrite: false;
}

export const SPRINT27_PERMISSIONS: ActionPermissions = { aiWrite: false };

export type ActionRejection =
  | 'malformed'
  | 'too_many_actions'
  | 'unknown_type'
  | 'placement_blocked'
  | 'unknown_component'
  | 'unknown_terminal'
  | 'same_endpoint'
  | 'already_connected'
  | 'no_such_connection'
  | 'unknown_param'
  | 'param_type'
  | 'out_of_range'
  | 'off_grid'
  | 'not_standard'
  | 'no_program'
  | 'file_path_invalid'
  | 'file_too_large'
  | 'unknown_library'
  | 'library_mismatch'
  | 'electrical_rule'
  | 'earlier_action_rejected';

export interface ActionPreview {
  added?: { id: string; type: string };
  connected?: { from: string; to: string };
  disconnected?: { from: string; to: string; wires: number };
  value?: { component: string; param: string; before: ParamValue | null; after: ParamValue };
  file?: { board: string; path: string; created: boolean; bytesBefore: number; bytesAfter: number };
  library?: { id: string; version: string };
  validation?: 'build' | 'run';
}

export interface ActionOutcome {
  index: number;
  kind: ProposedAction['kind'];
  ok: boolean;
  rejection?: ActionRejection;
  detail?: string;
  preview?: ActionPreview;
}

export interface DryRun {
  /** Valid as a whole (every action valid, no electrical rule broken)? */
  valid: boolean;
  /** May it be applied? Sprint 27: never for AI-origin proposals. */
  applicable: boolean;
  notApplicableReason?: 'ai_write_disabled' | 'invalid';
  outcomes: ActionOutcome[];
  /** Editor-check issues the result would have that the project does not have now. */
  newIssues: CheckIssue[];
}

/** Editor issues that make a proposal invalid outright (a supply shorted by the change). */
const BLOCKING_ISSUES = new Set(['psu_shorted_by_wire', 'supply_pins_shorted']);

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 96): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max;
const termRef = (v: unknown): v is TerminalRef =>
  isObj(v) && str(v.component, 32) && str(v.terminal, 32) && Object.keys(v).length === 2;

/** Strict shape check of an envelope received from anywhere (a provider's output included). */
export function parseEnvelope(body: unknown): ActionEnvelope | null {
  if (!isObj(body) || body.protocol !== ACTION_PROTOCOL) return null;
  // Exactly these keys: an envelope claiming its own origin (or anything else) is malformed.
  if (Object.keys(body).some((k) => !['protocol', 'rationale', 'cites', 'actions'].includes(k)))
    return null;
  if (
    body.rationale !== undefined &&
    (typeof body.rationale !== 'string' || body.rationale.length > ACTION_LIMITS.maxRationaleChars)
  )
    return null;
  if (!Array.isArray(body.cites) || !body.cites.every((c) => str(c, 64))) return null;
  if (!Array.isArray(body.actions)) return null;
  for (const a of body.actions) {
    if (!isObj(a)) return null;
    const keys = Object.keys(a).sort().join(',');
    switch (a.kind) {
      case 'add_component':
        if (
          !str(a.type, 64) ||
          (a.at !== undefined &&
            !(isObj(a.at) && Number.isInteger(a.at.x) && Number.isInteger(a.at.y)))
        )
          return null;
        if (!['kind,type', 'at,kind,type'].includes(keys)) return null;
        break;
      case 'connect':
      case 'disconnect':
        if (!termRef(a.from) || !termRef(a.to) || keys !== 'from,kind,to') return null;
        break;
      case 'set_value':
        if (!str(a.component, 32) || !str(a.param, 48)) return null;
        if (!['number', 'boolean', 'string'].includes(typeof a.value)) return null;
        if (typeof a.value === 'number' && !Number.isFinite(a.value)) return null;
        if (!['component,kind,param,value', 'component,kind,param,unit,value'].includes(keys))
          return null;
        break;
      case 'write_file':
        if (
          !str(a.board, 32) ||
          !str(a.path, 96) ||
          typeof a.text !== 'string' ||
          keys !== 'board,kind,path,text'
        )
          return null;
        break;
      case 'select_library':
        if (
          !str(a.board, 32) ||
          !str(a.id, 64) ||
          !str(a.version, 48) ||
          keys !== 'board,id,kind,version'
        )
          return null;
        break;
      case 'request_validation':
        if ((a.what !== 'build' && a.what !== 'run') || keys !== 'kind,what') return null;
        break;
      default:
        return null;
    }
  }
  return body as unknown as ActionEnvelope;
}

const pinKey = (r: TerminalRef) => `${r.component}.${r.terminal}`;

/**
 * Validate and dry-run a proposal. The given document is never modified; the preview comes from
 * the domain's own edit operations on a copy, applied in order.
 */
export function dryRun(
  doc: ProjectDocument,
  envelope: unknown,
  /** Where the envelope came from, as the caller knows it; 'ai' unless stated (fails closed). */
  origin: ActionOrigin = 'ai',
  opts: {
    permissions?: ActionPermissions;
    /** The context's evidence refs: every citation must be one of them (contextRefs). */
    refs?: ReadonlySet<string>;
  } = {},
): DryRun {
  const permissions = opts.permissions ?? SPRINT27_PERMISSIONS;
  const parsed = parseEnvelope(envelope);
  if (!parsed || (opts.refs && !parsed.cites.every((c) => opts.refs!.has(c))))
    return {
      valid: false,
      applicable: false,
      notApplicableReason: 'invalid',
      outcomes: [{ index: -1, kind: 'request_validation', ok: false, rejection: 'malformed' }],
      newIssues: [],
    };
  if (parsed.actions.length > ACTION_LIMITS.maxActions || parsed.actions.length === 0)
    return {
      valid: false,
      applicable: false,
      notApplicableReason: 'invalid',
      outcomes: [
        { index: -1, kind: 'request_validation', ok: false, rejection: 'too_many_actions' },
      ],
      newIssues: [],
    };

  let work = cloneDocument(doc);
  const added: string[] = [];
  const outcomes: ActionOutcome[] = [];
  let failed = false;
  const resolve = (id: string) => (id.startsWith('new:') ? added[Number(id.slice(4))] : id);
  const terminalOk = (r: TerminalRef): string | null => {
    const id = resolve(r.component);
    const c = id ? work.components.find((x) => x.id === id) : undefined;
    if (!c) return 'unknown_component';
    if (!CATALOG[c.type].terminals.some((t) => t.id === r.terminal)) return 'unknown_terminal';
    return null;
  };

  parsed.actions.forEach((a, index) => {
    const reject = (rejection: ActionRejection, detail?: string) => {
      failed = true;
      outcomes.push({ index, kind: a.kind, ok: false, rejection, ...(detail ? { detail } : {}) });
    };
    if (failed)
      return outcomes.push({
        index,
        kind: a.kind,
        ok: false,
        rejection: 'earlier_action_rejected',
      });
    switch (a.kind) {
      case 'add_component': {
        if (!isComponentType(a.type) || !getTypeDef(a.type)) return reject('unknown_type');
        const block = placementBlock(work, a.type);
        if (block) return reject('placement_blocked', block);
        const r = addComponent(work, a.type, a.at ?? { x: 0, y: 0 });
        if (!r.ok) return reject('unknown_type', r.error);
        work = r.doc;
        added.push(r.id);
        return outcomes.push({
          index,
          kind: a.kind,
          ok: true,
          preview: { added: { id: r.id, type: a.type } },
        });
      }
      case 'connect':
      case 'disconnect': {
        const bad = terminalOk(a.from) ?? terminalOk(a.to);
        if (bad) return reject(bad as ActionRejection);
        const from = { component: resolve(a.from.component)!, terminal: a.from.terminal };
        const to = { component: resolve(a.to.component)!, terminal: a.to.terminal };
        const ends = (w: (typeof work.layout.wires)[number]) =>
          [w.from, w.to]
            .map((e) => (e.kind === 'terminal' ? `${e.component}.${e.terminal}` : ''))
            .sort()
            .join('|');
        const want = [pinKey(from), pinKey(to)].sort().join('|');
        const wires = work.layout.wires.filter((w) => ends(w) === want);
        if (a.kind === 'connect') {
          if (wires.length) return reject('already_connected');
          const r = addWire(work, { kind: 'terminal', ...from }, { kind: 'terminal', ...to });
          if (!r.ok)
            return reject(
              r.error === 'same_endpoint' ? 'same_endpoint' : 'unknown_terminal',
              r.error,
            );
          work = r.doc;
          return outcomes.push({
            index,
            kind: a.kind,
            ok: true,
            preview: { connected: { from: pinKey(from), to: pinKey(to) } },
          });
        }
        if (!wires.length) return reject('no_such_connection');
        const r = deleteSelection(work, {
          components: [],
          wires: wires.map((w) => w.id),
          junctions: [],
        });
        if (!r.ok) return reject('no_such_connection', r.error);
        work = r.doc;
        return outcomes.push({
          index,
          kind: a.kind,
          ok: true,
          preview: { disconnected: { from: pinKey(from), to: pinKey(to), wires: wires.length } },
        });
      }
      case 'set_value': {
        const id = resolve(a.component);
        const c = id ? work.components.find((x) => x.id === id) : undefined;
        if (!c || !id) return reject('unknown_component');
        const def = CATALOG[c.type].params.find((p) => p.key === a.param);
        if (!def) return reject('unknown_param');
        let value: ParamValue;
        if (def.kind === 'quantity') {
          if (typeof a.value !== 'number' || (a.unit !== undefined && a.unit !== def.unit))
            return reject('param_type');
          value = { value: a.value, unit: def.unit };
        } else value = a.value as ParamValue;
        const before = c.params[a.param] ?? null;
        const r = setParam(work, id, a.param, value);
        if (!r.ok) return reject(r.error as ActionRejection);
        work = r.doc;
        return outcomes.push({
          index,
          kind: a.kind,
          ok: true,
          preview: { value: { component: id, param: a.param, before, after: value } },
        });
      }
      case 'write_file': {
        const p = work.programs[a.board];
        if (!p) return reject('no_program');
        const bytes = new TextEncoder().encode(a.text).length;
        if (bytes > ACTION_LIMITS.maxFileBytes) return reject('file_too_large');
        const existing =
          a.path === p.fileName ? p.text : p.files?.find((f) => f.path === a.path)?.text;
        if (existing === undefined) {
          const issue = programPathIssue(
            p.language as ProgramLanguage,
            a.path,
            (p.files ?? []).map((f) => f.path),
          );
          if (issue) return reject('file_path_invalid', issue);
          const r = addProgramFile(work, a.board, a.path, a.text);
          if (!r.ok) return reject('file_path_invalid', r.error);
          work = r.doc;
        } else {
          const r = setProgramText(
            work,
            a.board,
            a.text,
            a.path === p.fileName ? undefined : a.path,
          );
          if (!r.ok)
            return reject(
              r.error === 'source_too_large' || r.error === 'project_too_large'
                ? 'file_too_large'
                : 'file_path_invalid',
              r.error,
            );
          work = r.doc;
        }
        return outcomes.push({
          index,
          kind: a.kind,
          ok: true,
          preview: {
            file: {
              board: a.board,
              path: a.path,
              created: existing === undefined,
              bytesBefore: existing === undefined ? 0 : new TextEncoder().encode(existing).length,
              bytesAfter: bytes,
            },
          },
        });
      }
      case 'select_library': {
        const p = work.programs[a.board];
        if (!p) return reject('no_program');
        const lib = managedLibrary(a.id, a.version);
        if (!lib) return reject('unknown_library');
        if (lib.language !== p.language || !lib.profiles.includes(p.profile))
          return reject('library_mismatch');
        const libs = (p.libraries ?? []).filter((l) => l.id !== a.id);
        work = cloneDocument(work);
        work.programs[a.board]!.libraries = sortLibraryRefs([
          ...libs,
          { id: a.id, version: a.version },
        ]);
        return outcomes.push({
          index,
          kind: a.kind,
          ok: true,
          preview: { library: { id: a.id, version: a.version } },
        });
      }
      case 'request_validation':
        return outcomes.push({ index, kind: a.kind, ok: true, preview: { validation: a.what } });
    }
  });

  // Electrical rules: issues the change would introduce (editor checks; the engine judges at Run).
  const key = (i: CheckIssue) =>
    `${i.code}|${i.components.join(',')}|${(i.terminals ?? []).join(',')}`;
  const before = new Set(checkCircuit(doc).map(key));
  const newIssues = failed ? [] : checkCircuit(work).filter((i) => !before.has(key(i)));
  const broken = newIssues.find((i) => BLOCKING_ISSUES.has(i.code));
  if (broken) {
    failed = true;
    outcomes.push({
      index: -1,
      kind: 'request_validation',
      ok: false,
      rejection: 'electrical_rule',
      detail: broken.code,
    });
  }
  const valid = !failed;
  const applicable = valid && (origin === 'user' || permissions.aiWrite);
  return {
    valid,
    applicable,
    ...(applicable ? {} : { notApplicableReason: valid ? 'ai_write_disabled' : 'invalid' }),
    outcomes,
    newIssues,
  };
}

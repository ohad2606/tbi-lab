/**
 * Structural validation of a project document.
 *
 * This is not electrical validation (unconnected terminals, missing ground and similar rules
 * are Sprint 4). It guarantees the document is well-formed and internally consistent: every
 * reference resolves, ids are unique, and the netlist matches the wire graph exactly.
 * Errors are structured codes with data, never display text.
 */

import { CATALOG, isComponentType } from './catalog.js';
import { GRID, ROTATIONS } from './layout.js';
import { nodeKey, wireGroups } from './nets.js';
import { profileById, utf8Length } from './program.js';
import {
  DOCUMENT_FORMAT,
  SCHEMA_VERSION,
  WIRE_COLORS,
  type ProjectDocument,
  type WireEnd,
} from './schema.js';

export type ValidationCode =
  | 'not_an_object'
  | 'bad_format'
  | 'bad_schema_version'
  | 'bad_field'
  | 'duplicate_id'
  | 'unknown_type'
  | 'unsupported_type_version'
  | 'bad_param'
  | 'missing_param'
  | 'unknown_param'
  | 'missing_placement'
  | 'orphan_placement'
  | 'bad_placement'
  | 'dangling_reference'
  | 'unknown_terminal'
  | 'duplicate_connection'
  | 'netlist_mismatch'
  | 'bad_net_role'
  | 'self_wire'
  | 'reused_id'
  | 'bad_program';

export interface ValidationIssue {
  code: ValidationCode;
  path: string;
  detail?: string;
}

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

export function validateProject(input: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (code: ValidationCode, path: string, detail?: string) =>
    issues.push(detail === undefined ? { code, path } : { code, path, detail });

  if (!isObj(input)) return [{ code: 'not_an_object', path: '' }];
  if (input.format !== DOCUMENT_FORMAT) add('bad_format', 'format');
  if (input.schemaVersion !== SCHEMA_VERSION) {
    add('bad_schema_version', 'schemaVersion', String(input.schemaVersion));
    return issues; // Nothing else can be interpreted against the wrong schema.
  }
  if (typeof input.projectId !== 'string' || !/^prj_[A-Za-z0-9]+$/.test(input.projectId)) {
    add('bad_field', 'projectId');
  }
  if (typeof input.name !== 'string' || input.name.trim() === '') add('bad_field', 'name');
  if (typeof input.createdAt !== 'string') add('bad_field', 'createdAt');
  const cw = input.createdWith;
  if (!isObj(cw) || typeof cw.app !== 'string' || !isInt(cw.schemaVersion)) {
    add('bad_field', 'createdWith');
  }
  const rev = input.revision;
  if (
    !isObj(rev) ||
    !isInt(rev.localRevision) ||
    rev.localRevision < 1 ||
    !(rev.cloudRevision === null || isInt(rev.cloudRevision)) ||
    !(rev.baseRevision === null || isInt(rev.baseRevision)) ||
    typeof rev.updatedAt !== 'string' ||
    Number.isNaN(Date.parse(rev.updatedAt)) ||
    typeof rev.deviceId !== 'string'
  ) {
    add('bad_field', 'revision');
  }
  const counters = input.idCounters;
  if (!isObj(counters) || !Object.values(counters).every((n) => isInt(n) && n >= 0)) {
    add('bad_field', 'idCounters');
  }
  if (
    !Array.isArray(input.components) ||
    !Array.isArray(input.nets) ||
    !Array.isArray(input.connections) ||
    !isObj(input.layout) ||
    !isObj(input.layout.components) ||
    !Array.isArray(input.layout.wires) ||
    !Array.isArray(input.layout.junctions)
  ) {
    add('bad_field', 'components|nets|connections|layout');
    return issues;
  }
  if (issues.length) return issues;
  const doc = input as unknown as ProjectDocument;

  // Ids: well-formed, unique across components/wires/junctions/nets, and within counters.
  const seen = new Set<string>();
  const checkId = (id: unknown, path: string, prefix?: string) => {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) return add('bad_field', path);
    if (seen.has(id)) add('duplicate_id', path, id);
    seen.add(id);
    if (prefix !== undefined) {
      const m = new RegExp(`^${prefix}(\\d+)$`).exec(id);
      if (m && Number(m[1]) > (doc.idCounters[prefix.replace(/_$/, '')] ?? 0)) {
        add('reused_id', path, id);
      }
    }
  };

  doc.components.forEach((c, i) => {
    const path = `components[${i}]`;
    if (!isObj(c)) return add('bad_field', path);
    if (!isComponentType(c.type)) return add('unknown_type', `${path}.type`, String(c.type));
    const def = CATALOG[c.type];
    checkId(c.id, `${path}.id`, def.refPrefix);
    if (c.typeVersion !== def.typeVersion) {
      add('unsupported_type_version', `${path}.typeVersion`, String(c.typeVersion));
    }
    if (!isObj(c.params)) return add('bad_field', `${path}.params`);
    for (const p of def.params) {
      const v = c.params[p.key];
      const pp = `${path}.params.${p.key}`;
      if (v === undefined) {
        if (!(p.kind === 'enum' && p.optional)) add('missing_param', pp);
      } else if (p.kind === 'boolean') {
        if (typeof v !== 'boolean') add('bad_param', pp);
      } else if (p.kind === 'enum') {
        if (typeof v !== 'string' || !p.options.some((o) => o.value === v)) add('bad_param', pp);
      } else if (
        !isObj(v) ||
        v.unit !== p.unit ||
        typeof v.value !== 'number' ||
        !Number.isFinite(v.value) ||
        v.value < p.min ||
        v.value > p.max ||
        Object.keys(v).length !== 2
      ) {
        add('bad_param', pp);
      }
    }
    for (const k of Object.keys(c.params)) {
      if (!def.params.some((p) => p.key === k)) add('unknown_param', `${path}.params.${k}`);
    }
  });
  // Only well-formed components of known types can be referenced; the rest are already reported.
  const components = new Map(
    doc.components.filter((c) => isObj(c) && isComponentType(c.type)).map((c) => [c.id, c]),
  );

  // Placements: exactly one per component, on the grid, with a valid rotation.
  for (const c of components.values()) {
    const p = doc.layout.components[c.id];
    if (!p) add('missing_placement', `layout.components.${c.id}`);
    else if (
      !isObj(p) ||
      !isInt(p.x) ||
      !isInt(p.y) ||
      p.x % GRID ||
      p.y % GRID ||
      !ROTATIONS.includes(p.rotation)
    ) {
      add('bad_placement', `layout.components.${c.id}`);
    }
  }
  for (const id of Object.keys(doc.layout.components)) {
    if (!components.has(id)) add('orphan_placement', `layout.components.${id}`);
  }

  doc.layout.junctions.forEach((j, i) => {
    if (!isObj(j)) return add('bad_field', `layout.junctions[${i}]`);
    checkId(j.id, `layout.junctions[${i}].id`, 'J');
    if (!isInt(j.x) || !isInt(j.y)) add('bad_field', `layout.junctions[${i}]`);
  });
  const junctions = new Set(doc.layout.junctions.filter(isObj).map((j) => j.id));

  const endOk = (e: WireEnd, path: string): boolean => {
    if (!isObj(e)) return (add('bad_field', path), false);
    if (e.kind === 'junction') {
      if (!junctions.has(e.junction)) return (add('dangling_reference', path, e.junction), false);
      return true;
    }
    if (e.kind === 'terminal') {
      const c = components.get(e.component);
      if (!c) return (add('dangling_reference', path, e.component), false);
      if (!CATALOG[c.type].terminals.some((t) => t.id === e.terminal)) {
        return (add('unknown_terminal', path, `${e.component}.${e.terminal}`), false);
      }
      return true;
    }
    return (add('bad_field', path), false);
  };
  let wiresOk = true;
  doc.layout.wires.forEach((w, i) => {
    const path = `layout.wires[${i}]`;
    if (!isObj(w)) return ((wiresOk = false), add('bad_field', path));
    checkId(w.id, `${path}.id`, 'W');
    const ok = endOk(w.from, `${path}.from`) && endOk(w.to, `${path}.to`);
    if (!ok) wiresOk = false;
    else if (nodeKey(w.from) === nodeKey(w.to)) add('self_wire', path);
    if (
      !Array.isArray(w.vertices) ||
      !w.vertices.every((v) => isObj(v) && isInt(v.x) && isInt(v.y))
    ) {
      add('bad_field', `${path}.vertices`);
    }
    if (
      w.auto !== undefined &&
      !(
        isObj(w.auto) &&
        Array.isArray(w.auto.waypoints) &&
        w.auto.waypoints.every((v) => isObj(v) && isInt(v.x) && isInt(v.y))
      )
    ) {
      add('bad_field', `${path}.auto`);
    }
    if (w.color !== undefined && !(WIRE_COLORS as readonly unknown[]).includes(w.color)) {
      add('bad_field', `${path}.color`);
    }
  });

  // Nets and connections.
  doc.nets.forEach((n, i) => {
    if (!isObj(n)) return add('bad_field', `nets[${i}]`);
    checkId(n.id, `nets[${i}].id`, 'N_');
    if (!(n.role === null || n.role === 'ground')) add('bad_net_role', `nets[${i}].role`);
    if (!(n.userName === null || typeof n.userName === 'string')) {
      add('bad_field', `nets[${i}].userName`);
    }
  });
  const nets = new Map(doc.nets.filter(isObj).map((n) => [n.id, n]));
  const terminalNet = new Map<string, string>();
  doc.connections.forEach((c, i) => {
    const path = `connections[${i}]`;
    if (!isObj(c)) return add('bad_field', path);
    const comp = components.get(c.component);
    if (!comp) return add('dangling_reference', path, c.component);
    if (!CATALOG[comp.type].terminals.some((t) => t.id === c.terminal)) {
      return add('unknown_terminal', path, `${c.component}.${c.terminal}`);
    }
    if (!nets.has(c.net)) return add('dangling_reference', path, c.net);
    const key = nodeKey({ kind: 'terminal', component: c.component, terminal: c.terminal });
    if (terminalNet.has(key)) return add('duplicate_connection', path, key);
    terminalNet.set(key, c.net);
  });

  // The netlist must be exactly the wire graph's connected groups.
  if (wiresOk) {
    const groups = wireGroups(doc);
    const groupNets = new Set<string>();
    const wired = new Set<string>();
    for (const g of groups) {
      const netsInGroup = new Set(
        g.filter((k) => k.startsWith('t:')).map((k) => terminalNet.get(k)),
      );
      for (const k of g) wired.add(k);
      if (netsInGroup.size === 0) continue;
      if (netsInGroup.size !== 1 || netsInGroup.has(undefined)) {
        add('netlist_mismatch', 'connections', g.join(','));
        continue;
      }
      const net = [...netsInGroup][0]!;
      if (groupNets.has(net)) add('netlist_mismatch', 'nets', net);
      groupNets.add(net);
      const ground = g.some((k) => {
        const [, comp, term] = k.split(':');
        const c = comp !== undefined ? components.get(comp) : undefined;
        return k.startsWith('t:') && !!c && CATALOG[c.type].groundTerminal === term;
      });
      if ((nets.get(net)?.role === 'ground') !== ground) add('bad_net_role', 'nets', net);
    }
    for (const key of terminalNet.keys()) {
      if (!wired.has(key)) add('netlist_mismatch', 'connections', key);
    }
    if (doc.nets.length !== groupNets.size) {
      add('netlist_mismatch', 'nets', `${doc.nets.length} nets for ${groups.length} groups`);
    }
  }

  // Programs (schema v3): keyed by an existing board of the profile's board type; at most one
  // in V1; the profile's file name; exact text within the profile's size limit.
  if (!isObj(input.programs)) add('bad_field', 'programs');
  else {
    const entries = Object.entries(input.programs);
    if (entries.length > 1) add('bad_program', 'programs', 'more than one program');
    for (const [boardId, program] of entries) {
      const path = `programs.${boardId}`;
      const board = doc.components.find((c) => c.id === boardId);
      if (!isObj(program)) {
        add('bad_program', path);
        continue;
      }
      const profile =
        typeof program.profile === 'string' ? profileById(program.profile) : undefined;
      if (!profile) add('bad_program', `${path}.profile`, String(program.profile));
      else if (!board || board.type !== profile.board) add('bad_program', path, 'no such board');
      else if (program.language !== profile.language) add('bad_program', `${path}.language`);
      else if (program.fileName !== profile.fileName) add('bad_program', `${path}.fileName`);
      else if (
        typeof program.text !== 'string' ||
        program.text.includes('\u0000') ||
        utf8Length(program.text) > profile.maxSourceBytes
      )
        add('bad_program', `${path}.text`);
      const extra = Object.keys(program).filter(
        (k) => !['language', 'profile', 'fileName', 'text'].includes(k),
      );
      if (extra.length) add('bad_program', path, `unknown ${extra.join(',')}`);
    }
  }

  return issues;
}

export function isValidProject(input: unknown): input is ProjectDocument {
  return validateProject(input).length === 0;
}

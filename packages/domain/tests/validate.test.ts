import { describe, expect, it } from 'vitest';
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  addComponent,
  addWire,
  openDocument,
  validateProject,
  type ProjectDocument,
} from '../src/index.js';
import { must, newDoc } from './helpers.js';

const t = (component: string, terminal: string) => ({
  kind: 'terminal' as const,
  component,
  terminal,
});

function wired(): ProjectDocument {
  let doc = must(addComponent(newDoc(), 'component.resistor', { x: 0, y: 0 })).doc;
  doc = must(addWire(doc, t('PSU1', 'positive'), t('R1', 'a'))).doc;
  return must(addWire(doc, t('PSU1', 'negative'), t('GND1', 'ref'))).doc;
}

function broken(mutate: (d: any) => void): unknown {
  const d = JSON.parse(JSON.stringify(wired()));
  mutate(d);
  return d;
}

const codes = (input: unknown) => validateProject(input).map((i) => i.code);

describe('validateProject rejects each malformed case with a structured error', () => {
  it('accepts a valid document', () => {
    expect(validateProject(wired())).toEqual([]);
  });

  const cases: [string, (d: any) => void, string][] = [
    ['wrong format marker', (d) => (d.format = 'something.else'), 'bad_format'],
    ['wrong schema version', (d) => (d.schemaVersion = 1), 'bad_schema_version'],
    ['project id with a locale-ish shape', (d) => (d.projectId = 'he/project'), 'bad_field'],
    ['empty name', (d) => (d.name = '  '), 'bad_field'],
    ['bad revision', (d) => (d.revision.localRevision = 0), 'bad_field'],
    ['non-ISO updatedAt', (d) => (d.revision.updatedAt = 'yesterday'), 'bad_field'],
    [
      'unknown component type',
      (d) => (d.components[2].type = 'component.transistor'),
      'unknown_type',
    ],
    [
      'unsupported type version',
      (d) => (d.components[2].typeVersion = 9),
      'unsupported_type_version',
    ],
    ['duplicate component id', (d) => (d.components[1].id = 'PSU1'), 'duplicate_id'],
    ['id beyond its counter (would be reused)', (d) => (d.idCounters.R = 0), 'reused_id'],
    [
      'value with wrong unit',
      (d) => (d.components[2].params.resistance.unit = 'volt'),
      'bad_param',
    ],
    ['value out of range', (d) => (d.components[2].params.resistance.value = -1), 'bad_param'],
    ['localized string as value', (d) => (d.components[2].params.resistance = 'אלף'), 'bad_param'],
    ['missing parameter', (d) => delete d.components[0].params.currentLimit, 'missing_param'],
    ['unknown parameter', (d) => (d.components[2].params.label = 'x'), 'unknown_param'],
    ['missing placement', (d) => delete d.layout.components.R1, 'missing_placement'],
    [
      'orphan placement',
      (d) => (d.layout.components.R9 = { x: 0, y: 0, rotation: 0 }),
      'orphan_placement',
    ],
    ['off-grid placement', (d) => (d.layout.components.R1.x = 7), 'bad_placement'],
    ['bad rotation', (d) => (d.layout.components.R1.rotation = 45), 'bad_placement'],
    [
      'wire to a missing component',
      (d) => (d.layout.wires[0].to.component = 'R7'),
      'dangling_reference',
    ],
    [
      'wire to a missing junction',
      (d) => (d.layout.wires[0].to = { kind: 'junction', junction: 'J9' }),
      'dangling_reference',
    ],
    [
      'wire to an unknown terminal',
      (d) => (d.layout.wires[0].to.terminal = 'c'),
      'unknown_terminal',
    ],
    ['connection to a missing net', (d) => (d.connections[0].net = 'N_99'), 'dangling_reference'],
    [
      'connection to a missing component',
      (d) => (d.connections[0].component = 'R5'),
      'dangling_reference',
    ],
    [
      'duplicate connection',
      (d) => d.connections.push({ ...d.connections[0] }),
      'duplicate_connection',
    ],
    [
      'netlist disagrees with the wires',
      (d) => (d.connections.find((c: any) => c.component === 'R1').net = 'N_2'),
      'netlist_mismatch',
    ],
    [
      'unwired terminal claims a net',
      (d) => d.connections.push({ component: 'R1', terminal: 'b', net: 'N_1' }),
      'netlist_mismatch',
    ],
    [
      'stale extra net',
      (d) => d.nets.push({ id: 'N_2', role: null, userName: null }),
      'duplicate_id',
    ],
    ['ground role on a non-ground net', (d) => (d.nets[0].role = 'ground'), 'bad_net_role'],
    ['missing ground role', (d) => (d.nets[1].role = null), 'bad_net_role'],
  ];
  for (const [name, mutate, code] of cases) {
    it(name, () => {
      expect(codes(broken(mutate))).toContain(code);
    });
  }

  it('rejects non-objects', () => {
    expect(codes(null)).toEqual(['not_an_object']);
    expect(codes([])).toEqual(['not_an_object']);
  });
});

describe('openDocument and the migration registry', () => {
  it('opens a current document unchanged', () => {
    const doc = wired();
    const r = openDocument(JSON.parse(JSON.stringify(doc)));
    expect(r).toEqual({ status: 'ok', doc, migratedFrom: null });
  });

  it('has no migrations yet: v2 is the first production schema', () => {
    expect(Object.keys(MIGRATIONS)).toEqual([]);
  });

  it('refuses to interpret a NEWER schema and reports it for read-only opening', () => {
    const raw = { ...wired(), schemaVersion: SCHEMA_VERSION + 1 };
    expect(openDocument(raw)).toEqual({ status: 'newer', schemaVersion: SCHEMA_VERSION + 1, raw });
  });

  it('runs registered migrations in order on open', () => {
    const target = wired();
    const legacy: Record<string, unknown> = {
      ...JSON.parse(JSON.stringify(target)),
      schemaVersion: 1,
    };
    delete legacy.idCounters;
    const calls: number[] = [];
    const r = openDocument(legacy, {
      1: (d) => {
        calls.push(1);
        return { ...d, idCounters: target.idCounters };
      },
    });
    expect(calls).toEqual([1]);
    expect(r).toEqual({ status: 'ok', doc: target, migratedFrom: 1 });
  });

  it('reports an older schema with no migration path instead of guessing', () => {
    expect(openDocument({ ...wired(), schemaVersion: 1 })).toEqual({
      status: 'unmigratable',
      schemaVersion: 1,
    });
  });

  it('reports invalid documents with their issues', () => {
    const r = openDocument({ ...wired(), components: 'nope' });
    expect(r.status).toBe('invalid');
  });
});

describe('validateProject never throws', () => {
  it('reports rather than crashes on 2,000 randomly corrupted documents', () => {
    let s = 7;
    const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const junk = [null, 0, -1, 1.5, '', 'x', true, [], {}, { kind: 'terminal' }, NaN];
    const paths = (o: any, prefix: string[] = []): string[][] =>
      o && typeof o === 'object'
        ? Object.keys(o).flatMap((k) => [[...prefix, k], ...paths(o[k], [...prefix, k])])
        : [];
    const base = wired();
    const all = paths(base);
    for (let n = 0; n < 2000; n++) {
      const d: any = JSON.parse(JSON.stringify(base));
      const path = all[Math.floor(r() * all.length)]!;
      let o = d;
      for (const k of path.slice(0, -1)) o = o[k];
      o[path[path.length - 1]!] = junk[Math.floor(r() * junk.length)];
      expect(() => validateProject(d), path.join('.')).not.toThrow();
    }
  });
});

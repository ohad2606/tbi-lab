/**
 * Sprint 5: SHA-256, canonical JSON, the portable package and library identity operations.
 */
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CANONICALIZATION,
  PACKAGE_FORMAT,
  PACKAGE_MAX_BYTES,
  PACKAGE_VERSION,
  addComponent,
  addWire,
  canonicalJson,
  copyAsNewProject,
  createPackage,
  engineeringContent,
  parsePackage,
  projectHash,
  renameNet,
  serializePackage,
  setParam,
  sha256Hex,
  sha256Utf8,
  validateProject,
  type ProjectDocument,
} from '../src/index.js';
import { fixedClock, must, newDoc } from './helpers.js';

const t = (component: string, terminal: string) => ({
  kind: 'terminal' as const,
  component,
  terminal,
});

/** PSU -> toggle (closed) -> R1 4.7 kΩ -> GND, with a Hebrew user net name. */
function circuit(): ProjectDocument {
  let doc = newDoc();
  doc = must(addComponent(doc, 'component.toggle_switch', { x: 0, y: -20 })).doc;
  doc = must(addComponent(doc, 'component.resistor', { x: 140, y: 80 })).doc;
  doc = must(addWire(doc, t('PSU1', 'positive'), t('SW1', 'a'))).doc;
  doc = must(addWire(doc, t('SW1', 'b'), t('R1', 'a'))).doc;
  doc = must(addWire(doc, t('R1', 'b'), t('GND1', 'ref'))).doc;
  doc = must(addWire(doc, t('PSU1', 'negative'), t('GND1', 'ref'))).doc;
  doc = must(setParam(doc, 'SW1', 'closed', true)).doc;
  doc = must(setParam(doc, 'R1', 'resistance', { value: 4700, unit: 'ohm' })).doc;
  doc = must(setParam(doc, 'PSU1', 'outputEnabled', true)).doc;
  const net = doc.connections.find((c) => c.component === 'R1' && c.terminal === 'a')!.net;
  doc = must(renameNet(doc, net, 'מתח יציאה ✓ "q" \\ 𝛀')).doc;
  return { ...doc, name: 'מעגל בדיקה — Test ✓' };
}

const pack = (doc: ProjectDocument) =>
  serializePackage(createPackage(doc, { appVersion: '0.2.0', exportedAt: '2026-09-23T10:00:00Z' }));

describe('SHA-256 (FIPS 180-4)', () => {
  it('matches the NIST / FIPS 180-4 test vectors', () => {
    expect(sha256Utf8('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Utf8('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(
      sha256Utf8(
        'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
      ),
    ).toBe('cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1');
    expect(sha256Hex(new Uint8Array(1_000_000).fill(0x61))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it('agrees with OpenSSL (node:crypto) on every length 0..300 and random inputs', () => {
    for (let n = 0; n <= 300; n++) {
      const bytes = new Uint8Array(randomBytes(n));
      expect(sha256Hex(bytes), `length ${n}`).toBe(
        createHash('sha256').update(bytes).digest('hex'),
      );
    }
    for (let i = 0; i < 20; i++) {
      const bytes = new Uint8Array(randomBytes(1 + Math.floor(Math.random() * 70_000)));
      expect(sha256Hex(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  });

  it('hashes text as UTF-8 (Hebrew, emoji, astral characters)', () => {
    const s = 'אדמה (GND) ✓ 𝛀 😀';
    expect(sha256Utf8(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
  });
});

describe('canonical JSON', () => {
  it('sorts keys at every level and has no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });
  it('is independent of key insertion order', () => {
    const doc = circuit();
    const reversed = JSON.parse(
      JSON.stringify(doc, (_k, v: unknown) =>
        v && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).reverse())
          : v,
      ),
    ) as ProjectDocument;
    expect(canonicalJson(reversed)).toBe(canonicalJson(doc));
    expect(projectHash(reversed)).toBe(projectHash(doc));
  });
  it('refuses non-JSON values instead of dropping them', () => {
    expect(() => canonicalJson({ a: NaN })).toThrow();
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson(new Date())).toThrow();
  });
  it('any engineering change changes the hash; nothing else does', () => {
    const doc = circuit();
    const h = projectHash(doc);
    expect(projectHash(structuredClone(doc))).toBe(h);
    expect(projectHash(must(setParam(doc, 'SW1', 'closed', false)).doc)).not.toBe(h);
    expect(
      projectHash(must(setParam(doc, 'R1', 'resistance', { value: 4701, unit: 'ohm' })).doc),
    ).not.toBe(h);
  });
});

describe('portable package v1 (A4, A6)', () => {
  it('has exactly the documented envelope, with the exact project inside', () => {
    const doc = circuit();
    const pkg = JSON.parse(pack(doc)) as Record<string, unknown>;
    expect(Object.keys(pkg)).toEqual([
      'format',
      'formatVersion',
      'project',
      'source',
      'firmware',
      'toolchain',
      'integrity',
      'exported',
    ]);
    expect(pkg).toMatchObject({
      format: PACKAGE_FORMAT,
      formatVersion: PACKAGE_VERSION,
      source: null,
      firmware: null,
      toolchain: null,
      integrity: { algorithm: 'sha256', canonicalization: CANONICALIZATION },
      exported: { app: 'TBI Lab', appVersion: '0.2.0', exportedAt: '2026-09-23T10:00:00Z' },
    });
    expect(pkg.project).toEqual(doc);
    expect((pkg.integrity as { project: string }).project).toBe(projectHash(doc));
  });

  it('round-trips exactly: engineering content, toggle state and user text', () => {
    const doc = circuit();
    const parsed = parsePackage(pack(doc));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.doc).toEqual(doc);
    expect(parsed.doc.components.find((c) => c.id === 'SW1')!.params.closed).toBe(true);
    expect(parsed.doc.name).toBe('מעגל בדיקה — Test ✓');
    expect(parsed.doc.nets.some((n) => n.userName === 'מתח יציאה ✓ "q" \\ 𝛀')).toBe(true);
  });

  it('contains no runtime state (results, probes, history, pressed buttons)', () => {
    const text = pack(circuit());
    for (const word of ['pressed', 'probe', 'history', 'outcome', 'result', 'selection', 'sim']) {
      expect(text.toLowerCase(), word).not.toContain(`"${word}`);
    }
  });

  it('accepts a byte-order mark and CRLF-reformatted JSON (the hash is over content)', () => {
    const doc = circuit();
    const text =
      '﻿' +
      JSON.stringify(createPackage(doc, { appVersion: 'x', exportedAt: 'y' }), null, 4).replace(
        /\n/g,
        '\r\n',
      );
    const r = parsePackage(text);
    expect(r.ok && r.doc).toEqual(doc);
  });
});

describe('import validation rejects before anything is written (A7)', () => {
  const good = () => JSON.parse(pack(circuit())) as Record<string, any>;
  const code = (text: string) => {
    const r = parsePackage(text);
    return r.ok ? 'ok' : r.error.code;
  };
  const rehash = (p: Record<string, any>) => {
    p.integrity.project = projectHash(p.project);
    return JSON.stringify(p);
  };

  it('size limit', () => {
    expect(code(' '.repeat(PACKAGE_MAX_BYTES + 1))).toBe('too_large');
    expect(code(pack(circuit()))).toBe('ok');
  });
  it('not JSON / not a package / ZIP container', () => {
    expect(code('')).toBe('not_json');
    expect(code('{"format": ')).toBe('not_json');
    expect(code('<html>')).toBe('not_json');
    expect(code('[]')).toBe('not_a_package');
    expect(code('{"format":"tbi-lab.project"}')).toBe('not_a_package');
    expect(code(JSON.stringify(circuit()))).toBe('not_a_package'); // a bare project document
    expect(code('PK\u0003\u0004binary')).toBe('newer_package');
  });
  it('package version: future refused, malformed refused', () => {
    expect(code(JSON.stringify({ ...good(), formatVersion: 2 }))).toBe('newer_package');
    const r = parsePackage(JSON.stringify({ ...good(), formatVersion: 7 }));
    expect(!r.ok && r.error.version).toBe(7);
    expect(code(JSON.stringify({ ...good(), formatVersion: '1' }))).toBe('bad_package');
    expect(code(JSON.stringify({ ...good(), formatVersion: 0 }))).toBe('bad_package');
  });
  it('unknown or missing envelope fields', () => {
    expect(code(JSON.stringify({ ...good(), extra: 1 }))).toBe('bad_package');
    const p = good();
    delete p.exported;
    expect(code(JSON.stringify(p))).toBe('bad_package');
    expect(
      code(JSON.stringify({ ...good(), integrity: { ...good().integrity, algorithm: 'md5' } })),
    ).toBe('bad_package');
  });
  it('firmware/source/toolchain content is not supported in version 1', () => {
    expect(code(JSON.stringify({ ...good(), firmware: [{ name: 'a.bin' }] }))).toBe(
      'unsupported_content',
    );
    expect(code(JSON.stringify({ ...good(), source: 'void setup(){}' }))).toBe(
      'unsupported_content',
    );
  });
  it('any change to the project without a matching hash is refused', () => {
    const p = good();
    p.project.components.find((c: { id: string }) => c.id === 'R1').params.resistance.value = 1;
    expect(code(JSON.stringify(p))).toBe('hash_mismatch');
    const q = good();
    q.integrity.project = '0'.repeat(64);
    expect(code(JSON.stringify(q))).toBe('hash_mismatch');
  });
  it('a future schema is refused safely, even with a valid hash', () => {
    const p = good();
    p.project.schemaVersion = 3;
    const r = parsePackage(rehash(p));
    expect(!r.ok && r.error).toEqual({ code: 'newer_schema', version: 3 });
  });
  it('an older schema without a migration is refused', () => {
    const p = good();
    p.project.schemaVersion = 1;
    expect(code(rehash(p))).toBe('unsupported_schema');
  });
  it('invalid engineering data is refused with structural codes', () => {
    const cases: [string, (p: Record<string, any>) => void, string][] = [
      [
        'unknown component type',
        (p) => (p.project.components[0].type = 'component.capacitor'),
        'unknown_type',
      ],
      [
        'bad unit',
        (p) =>
          (p.project.components.find((c: any) => c.id === 'R1').params.resistance.unit = 'volt'),
        'bad_param',
      ],
      [
        'out of range',
        (p) =>
          (p.project.components.find((c: any) => c.id === 'R1').params.resistance.value = 1e12),
        'bad_param',
      ],
      [
        'string value',
        (p) =>
          (p.project.components.find((c: any) => c.id === 'R1').params.resistance.value = '4700'),
        'bad_param',
      ],
      [
        'toggle not boolean',
        (p) => (p.project.components.find((c: any) => c.id === 'SW1').params.closed = 'yes'),
        'bad_param',
      ],
      [
        'unknown param',
        (p) => (p.project.components.find((c: any) => c.id === 'R1').params.pressed = true),
        'unknown_param',
      ],
      [
        'dangling wire',
        (p) => (p.project.layout.wires[0].to.component = 'R99'),
        'dangling_reference',
      ],
      ['malformed id', (p) => (p.project.components[0].id = '1; DROP'), 'bad_field'],
      ['bad project id', (p) => (p.project.projectId = '../../etc'), 'bad_field'],
      ['unknown terminal', (p) => (p.project.connections[0].terminal = 'gate'), 'unknown_terminal'],
      ['netlist mismatch', (p) => p.project.connections.pop(), 'netlist_mismatch'],
      ['extra field', (p) => (p.project.components[0].script = 'alert(1)'), 'bad_field'],
      ['extra top field', (p) => (p.project.results = { R1: 1 }), 'bad_field'],
      [
        'extra quantity field',
        (p) =>
          (p.project.components.find((c: any) => c.id === 'R1').params.resistance.tolerance = 1),
        'bad_param',
      ],
    ];
    for (const [what, mutate, expected] of cases) {
      const p = good();
      mutate(p);
      const r = parsePackage(rehash(p));
      expect(r.ok, what).toBe(false);
      if (!r.ok) {
        expect(r.error.code, what).toBe('invalid_project');
        expect(
          r.error.issues!.map((i) => i.code),
          what,
        ).toContain(expected);
      }
    }
  });
  it('prototype-pollution keys are refused and pollute nothing', () => {
    const text = pack(circuit()).replace(
      '"source": null',
      '"__proto__": {"polluted": true}, "source": null',
    );
    expect(code(text)).toBe('not_json');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const text2 = pack(circuit()).replace(
      '"params": {',
      '"params": {"constructor": {"prototype": {}}, ',
    );
    expect(code(text2)).toBe('not_json');
  });
});

describe('copyAsNewProject: duplicate / import-as-copy / example identity (A2, A8)', () => {
  it('new identity and fresh history; engineering content and user text copied exactly', () => {
    const source = { ...circuit(), revision: { ...circuit().revision, localRevision: 42 } };
    const copy = copyAsNewProject(source, {
      projectId: 'prj_copy1',
      deviceId: 'device-b',
      appVersion: '0.2.0',
      name: 'Copy name',
      clock: { now: () => new Date('2026-10-01T00:00:00.000Z') },
    });
    expect(copy.projectId).toBe('prj_copy1');
    expect(copy.createdAt).toBe('2026-10-01T00:00:00.000Z');
    expect(copy.revision).toEqual({
      localRevision: 1,
      cloudRevision: null,
      baseRevision: null,
      updatedAt: '2026-10-01T00:00:00.000Z',
      deviceId: 'device-b',
    });
    expect(copy.name).toBe('Copy name');
    expect(engineeringContent(copy)).toEqual(engineeringContent(source));
    expect(validateProject(copy)).toEqual([]);
    // Independent: mutating the copy never touches the source.
    copy.components[0]!.params.outputEnabled = false;
    expect(source.components[0]!.params.outputEnabled).toBe(true);
  });
  it('keeps the source name verbatim when none is given', () => {
    const copy = copyAsNewProject(circuit(), {
      projectId: 'prj_c2',
      deviceId: 'd',
      appVersion: 'x',
      clock: fixedClock,
    });
    expect(copy.name).toBe('מעגל בדיקה — Test ✓');
  });
});

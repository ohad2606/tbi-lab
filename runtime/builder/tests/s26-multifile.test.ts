/**
 * Sprint 26: the build service's side of multi-file programs and managed libraries, without a
 * toolchain: the vendored sources match the registry, the request rules (paths, sizes, library
 * pins), the cache key, the job the provider gets, and the analyses that now see every file.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MANAGED_LIBRARIES, canonicalJson, sourceKey } from '@tbi-lab/domain';
import { libraryFiles, treeChecksum, verifyRegistry } from '../../libraries/tree.js';
import { checkRequestFiles, requestKey, requestLibraries } from '../libraries.js';
import { RequestError, validateBuildRequest, type BuildRequest } from '../protocol.js';
import { BuildService, DEFAULT_LIMITS } from '../service.js';
import { ArtifactStore } from '../store.js';
import { Grants } from '../grants.js';
import { analyzeFeatures } from '../features.js';
import { analyzeMicroPython } from '../pyFeatures.js';
import { projectModules } from '../micropython.js';
import { TEST_TICKET_KEY, principalFor } from '../../identity/test-gate.js';
import { openAccessPolicy } from '../../policy/testing.js';
import { FakeProvider, tempDir } from './support.js';

const A = principalFor('user-a');
const LCD = MANAGED_LIBRARIES.find((l) => l.id === 'arduino.liquidcrystal-pcf8574')!;
const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

const req = (files: { name: string; text: string }[], libraries?: BuildRequest['libraries']) =>
  ({
    protocol: 'tbi-lab.build/1',
    profile: 'esp32-arduino-3.3.12',
    files,
    ...(libraries ? { libraries } : {}),
  }) as BuildRequest;
const refused = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof RequestError ? `${e.status} ${e.reason}` : String(e);
  }
  return 'accepted';
};

describe('vendored library sources', () => {
  it('every registry entry is vendored byte for byte and matches its tree checksum', () => {
    verifyRegistry();
    const root = new URL('../../libraries/', import.meta.url).pathname;
    for (const lib of MANAGED_LIBRARIES) {
      const dir = join(root, lib.id, lib.version);
      const walk = (d: string): string[] =>
        readdirSync(d).flatMap((n) =>
          statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)],
        );
      const onDisk = walk(dir).map((p) => ({ path: relative(dir, p), bytes: readFileSync(p) }));
      expect(treeChecksum(onDisk)).toBe(lib.tree);
      expect(
        libraryFiles(lib)
          .map((f) => f.path)
          .sort(),
      ).toEqual(onDisk.map((f) => f.path).sort());
      // The licence travels with the source.
      expect(onDisk.some((f) => f.path === lib.license.file)).toBe(true);
    }
    // The tree checksum is canonical JSON of [{path, sha256}] (independent re-computation).
    const f = [{ path: 'a', bytes: Buffer.from('x') }];
    expect(treeChecksum(f)).toBe(
      createHash('sha256')
        .update(
          canonicalJson([{ path: 'a', sha256: createHash('sha256').update('x').digest('hex') }]),
        )
        .digest('hex'),
    );
  });

  it('a tampered tree is refused', () => {
    expect(() => libraryFiles({ ...LCD, tree: '0'.repeat(64) })).toThrow(/not the registry/);
    expect(() => libraryFiles({ ...LCD, version: '9.9.9' })).toThrow(/no vendored source/);
  });
});

describe('build requests with several files and libraries', () => {
  it('paths: relative names only, unique ignoring case; libraries: known exact versions', () => {
    const v = (body: unknown) => refused(() => validateBuildRequest(body));
    const base = { protocol: 'tbi-lab.build/1', profile: 'esp32-arduino-3.3.12' };
    expect(
      v({
        ...base,
        files: [
          { name: 'sketch.ino', text: '' },
          { name: 'src/a.cpp', text: '' },
        ],
      }),
    ).toBe('accepted');
    for (const name of ['../a.h', '/a.h', 'a//b.h', './a.h', 'a/../b.h', ''])
      expect(v({ ...base, files: [{ name, text: '' }] }), name).toBe('400 bad_file_name');
    expect(
      v({
        ...base,
        files: [
          { name: 'a.h', text: '' },
          { name: 'A.h', text: '' },
        ],
      }),
    ).toBe('400 bad_files');
    expect(
      v({ ...base, files: [{ name: 'sketch.ino', text: '' }], libraries: [{ id: 'x' }] }),
    ).toBe('400 bad_libraries');
    expect(v({ ...base, files: [{ name: 'sketch.ino', text: '' }], libraries: 'all' })).toBe(
      '400 bad_libraries',
    );
  });

  it('the profile rules: entry first, buildable paths, per-file and project limits', () => {
    const c = (r: BuildRequest) => refused(() => checkRequestFiles(r));
    expect(
      c(
        req([
          { name: 'sketch.ino', text: '' },
          { name: 'display.h', text: '' },
        ]),
      ),
    ).toBe('accepted');
    expect(c(req([{ name: 'display.h', text: '' }]))).toBe('400 bad_file_name');
    expect(
      c(
        req([
          { name: 'sketch.ino', text: '' },
          { name: 'lib/x.cpp', text: '' },
        ]),
      ),
    ).toBe('400 bad_file_name');
    expect(c(req([{ name: 'sketch.ino', text: 'x'.repeat(65 * 1024) }]))).toBe(
      '413 source_too_large',
    );
    const big = 'x'.repeat(60 * 1024);
    expect(
      c(
        req([
          { name: 'sketch.ino', text: big },
          ...[1, 2, 3, 4].map((i) => ({ name: `b${i}.h`, text: big })),
        ]),
      ),
    ).toBe('413 source_too_large');
  });

  it('libraries: exact registry versions of the request’s language, never substituted', () => {
    expect(
      requestLibraries(req([{ name: 'sketch.ino', text: '' }], [{ id: LCD.id, version: '2.2.0' }])),
    ).toEqual([LCD]);
    for (const l of [
      { id: LCD.id, version: '2.3.0' },
      { id: 'arduino.nope', version: '1.0.0' },
      { id: 'micropython.python-lcd', version: '0.0.0-git.7affb0b' },
    ])
      expect(refused(() => requestLibraries(req([{ name: 'sketch.ino', text: '' }], [l])))).toBe(
        '422 unknown_library',
      );
  });

  it('the cache key: unchanged for a one-file request; every file and library tree counts', () => {
    const one = req([{ name: 'sketch.ino', text: 'void setup(){}' }]);
    expect(requestKey(one)).toBe(sourceKey(one.profile, one.files));
    const lib = req(one.files, [{ id: LCD.id, version: '2.2.0' }]);
    expect(requestKey(lib)).toBe(
      sourceKey(one.profile, one.files, [{ id: LCD.id, version: '2.2.0', tree: LCD.tree }]),
    );
    expect(requestKey(lib)).not.toBe(requestKey(one));
    expect(requestKey(req([...one.files, { name: 'a.h', text: '' }]))).not.toBe(requestKey(one));
  });

  it('the service hands the provider every file in order and the resolved libraries; cache hit on resubmit', async () => {
    const store = tempDir('tbi-s26-store-');
    const work = tempDir('tbi-s26-work-');
    cleanup.push(store, work);
    const provider = new FakeProvider();
    const service = new BuildService(
      [provider],
      new ArtifactStore({ dir: store, capBytes: 64 * 1024 * 1024, graceMs: 0 }),
      work,
      DEFAULT_LIMITS,
      {
        grants: new Grants(':memory:'),
        ticketKey: TEST_TICKET_KEY,
        systemKeys: new Set(),
        ...openAccessPolicy(),
      },
    );
    const r = req(
      [
        { name: 'sketch.ino', text: '#include "display.h"\n' },
        { name: 'display.h', text: '#pragma once\n' },
      ],
      [{ id: LCD.id, version: '2.2.0' }],
    );
    const out = service.submit(r, A);
    expect('buildId' in out).toBe(true);
    await service.whenIdle();
    expect(provider.jobs[0]).toEqual({ files: r.files, libraries: [LCD.id] });
    expect('cached' in service.submit(r, A)).toBe(true);
    expect(provider.builds).toBe(1);
  });
});

describe('analyses over every file', () => {
  it('a pinned managed library is supported and requires what its part needs; others are named', () => {
    const base = { source: '', symbols: [], capabilities: ['i2c'] };
    expect(
      analyzeFeatures({ ...base, libraries: ['Wire', 'LiquidCrystal_PCF8574'], managed: [LCD] })
        .unsupported,
    ).toEqual([]);
    expect(
      analyzeFeatures({ ...base, libraries: ['Wire', 'LiquidCrystal_PCF8574'] }).unsupported,
    ).toEqual(['library:LiquidCrystal_PCF8574']);
    // Without the part's capability on the runtime, the managed library is not supported either.
    expect(
      analyzeFeatures({
        ...base,
        capabilities: [],
        libraries: ['LiquidCrystal_PCF8574'],
        managed: [LCD],
      }).unsupported,
    ).toEqual(['library:LiquidCrystal_PCF8574']);
  });

  it('review M1: a comment opened in one file, or "/*" in a string, hides nothing from the analysis', () => {
    const hidden = 'void f(){ ESP.restart(); setCpuFrequencyMhz(80); pinMode(5, INPUT_PULLUP); }\n';
    const r = analyzeFeatures({
      source: '',
      sources: ['void setup(){}\n/*', hidden + '// */\n'],
      symbols: [],
      libraries: [],
    });
    expect(r.restart).toBe(true);
    expect(r.unsupported).toContain('cpu_frequency');
    expect(r.internalPull).toEqual([5]);
    const one = analyzeFeatures({
      source: 'void a(){ Serial.print("/*"); ESP.restart(); Serial.print("*/"); }\n',
      symbols: [],
      libraries: [],
    });
    expect(one.restart).toBe(true);
    // Input reads: every file's pins, each file analysed on its own.
    const reads = analyzeFeatures({
      source: '',
      sources: ['/*', 'int f(){ return digitalRead(27); }\n'],
      symbols: [],
      libraries: [],
      capabilities: ['input-read'],
    });
    expect(reads.inputReads).toEqual({ pins: [27], unresolved: false });
  });

  it('review H1: a project module named like a firmware module never allows the firmware module', () => {
    expect(analyzeMicroPython('import network\n', ['i2c'], ['network']).unsupported).toEqual([
      'library:network',
    ]);
  });

  it('MicroPython: the project’s modules and packages and the pinned library modules import; nothing else', () => {
    expect(
      projectModules(['main.py', 'helpers.py', 'pkg/__init__.py', 'pkg/mod.py', 'loose/x.py']),
    ).toEqual(['helpers', 'pkg', 'pkg.mod']);
    const code =
      'import helpers\nfrom pkg.mod import f\nimport pkg.mod\nfrom machine_i2c_lcd import I2cLcd\n';
    const local = ['helpers', 'pkg', 'pkg.mod', 'machine_i2c_lcd', 'lcd_api'];
    expect(analyzeMicroPython(code, [], local).unsupported).toEqual([]);
    expect(analyzeMicroPython(code, [], []).unsupported).toEqual([
      'library:helpers',
      'library:machine_i2c_lcd',
      'library:pkg.mod',
    ]);
    expect(analyzeMicroPython('import loose.x\n', [], local).unsupported).toEqual([
      'library:loose.x',
    ]);
  });
});

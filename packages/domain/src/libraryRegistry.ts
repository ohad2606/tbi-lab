/**
 * Sprint 26: the managed library registry. A small, curated list of component libraries a program
 * may use without installing anything: each entry is one exact upstream version whose source is
 * vendored byte for byte in the repository (runtime/libraries/<id>/<version>/, checksummed here as
 * `tree`), with its licence, what it needs, the parts it serves and the operations that were
 * validated against the simulator. Nothing is fetched at build time (build jobs have no network).
 *
 * No compatibility is claimed beyond `validated`: other calls of a library may compile, but only
 * these were run on the real runtime against the part model, and the part's own refusals (an I2C
 * read of the LCD backpack, a clock above its rating) still apply to anything a library does.
 */
import type { ProgramLanguage } from './program.js';
import type { LibraryRef, ProgramSource, ProjectDocument } from './schema.js';

export interface ManagedLibrary {
  /** Stable id: `<language family>.<name>`. */
  id: string;
  /** Upstream name (technical, not translated). */
  name: string;
  language: ProgramLanguage;
  /** Exact version (an upstream tag, or `0.0.0-git.<commit>` for an untagged repository). */
  version: string;
  source: { url: string; commit: string; tag?: string };
  /** SPDX licence id and the copyright line of the vendored LICENSE file (attribution). */
  license: { spdx: string; copyright: string; file: string };
  /**
   * sha256 of the vendored source tree: canonical JSON of `[{path, sha256}]` sorted by path
   * (runtime/libraries/tree.ts). Part of the build's source key.
   */
  tree: string;
  /** Other managed libraries it needs (ids). */
  dependencies: string[];
  /** Build profiles it is validated with. */
  profiles: string[];
  /** Runtime bridge capabilities the parts it drives need. */
  runtimeCapabilities: string[];
  /** Component types it serves: placing one makes the library available. */
  components: string[];
  /** What the program writes to use it: Arduino headers, or MicroPython module names. */
  provides: string[];
  /** Operations run on the real runtime against the part model (technical identifiers). */
  validated: string[];
  /** Explicit limitations (message keys, localized). */
  limitations: string[];
  /** A short usage example (code, never translated). */
  example: string;
}

export const MANAGED_LIBRARIES: readonly ManagedLibrary[] = [
  {
    id: 'arduino.liquidcrystal-pcf8574',
    name: 'LiquidCrystal_PCF8574',
    language: 'arduino-cpp',
    version: '2.2.0',
    source: {
      url: 'https://github.com/mathertel/LiquidCrystal_PCF8574',
      tag: '2.2.0',
      commit: '4cb67f47f4a7a4249d41d22fc3b01e744d6de2df',
    },
    license: {
      spdx: 'BSD-3-Clause',
      copyright: 'Copyright (c) 2005-2020, Matthias Hertel, http://www.mathertel.de/',
      file: 'LICENSE',
    },
    tree: '53c31b649ae6d79870811a012ae51447094f8e7b2a7f3546c9b55e7ce86585db',
    dependencies: [],
    profiles: ['esp32-arduino-3.3.12'],
    runtimeCapabilities: ['i2c'],
    components: ['display.lcd1602_i2c'],
    provides: ['LiquidCrystal_PCF8574.h'],
    validated: ['begin', 'setBacklight', 'clear', 'home', 'setCursor', 'print'],
    limitations: ['library.limit.lcd_write_only', 'library.limit.lcd_clock'],
    example:
      '#include <Wire.h>\n#include <LiquidCrystal_PCF8574.h>\n\nLiquidCrystal_PCF8574 lcd(0x27);\n\nvoid setup() {\n  lcd.begin(16, 2);\n  lcd.setBacklight(255);\n  lcd.setCursor(0, 0);\n  lcd.print("Hello");\n}\n\nvoid loop() {}\n',
  },
  {
    id: 'micropython.python-lcd',
    name: 'python_lcd (I2cLcd)',
    language: 'micropython',
    version: '0.0.0-git.7affb0b',
    source: {
      url: 'https://github.com/dhylands/python_lcd',
      commit: '7affb0bceae672624ce1360a18c90623ca6857c1',
    },
    license: {
      spdx: 'MIT',
      copyright: 'Copyright (c) 2013 Dave Hylands',
      file: 'LICENSE',
    },
    tree: '72e6018dd756cdbd841e0200b1e3b83dd2b9182f9cca1ff6506284fbdafbd83e',
    dependencies: [],
    profiles: ['esp32-micropython-1.29'],
    runtimeCapabilities: ['i2c'],
    components: ['display.lcd1602_i2c'],
    provides: ['machine_i2c_lcd', 'lcd_api'],
    validated: ['I2cLcd', 'clear', 'move_to', 'putstr', 'backlight_on'],
    limitations: ['library.limit.lcd_write_only', 'library.limit.lcd_clock'],
    example:
      'from machine import I2C, Pin\nfrom machine_i2c_lcd import I2cLcd\n\ni2c = I2C(0, scl=Pin(22), sda=Pin(21), freq=100000)\nlcd = I2cLcd(i2c, 0x27, 2, 16)\nlcd.putstr("Hello")\n',
  },
];

export function managedLibrary(id: string, version?: string): ManagedLibrary | undefined {
  return MANAGED_LIBRARIES.find(
    (l) => l.id === id && (version === undefined || l.version === version),
  );
}

/** The libraries `ids` need, transitively (dependencies first, then each by id). Unknown ids: none. */
export function withDependencies(ids: readonly string[]): ManagedLibrary[] {
  const out: ManagedLibrary[] = [];
  const visit = (id: string, path: string[]) => {
    if (out.some((l) => l.id === id) || path.includes(id)) return;
    const lib = managedLibrary(id);
    if (!lib) return;
    for (const d of lib.dependencies) visit(d, [...path, id]);
    out.push(lib);
  };
  for (const id of [...ids].sort()) visit(id, []);
  return out;
}

/** Strip `//` and block comments from C/C++, and `#` comments from Python (string-unaware). */
const stripComments = (language: ProgramLanguage, text: string) =>
  language === 'micropython'
    ? text.replace(/#[^\n]*/g, '')
    : text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** The registry libraries a source text names (an `#include <…>` / `"…"`, or an `import` / `from`). */
export function librariesNamedBy(language: ProgramLanguage, text: string): string[] {
  const code = stripComments(language, text);
  const names = new Set<string>();
  if (language === 'micropython') {
    for (const m of code.matchAll(
      /^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import|import\s+([^\n]+))/gm,
    )) {
      const list = m[1] ? [m[1]] : m[2]!.split(',').map((s) => s.trim().split(/\s+/)[0]!);
      for (const n of list) names.add(n.split('.')[0]!);
    }
  } else {
    for (const m of code.matchAll(/^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm)) names.add(m[1]!.trim());
  }
  return MANAGED_LIBRARIES.filter(
    (l) => l.language === language && l.provides.some((p) => names.has(p)),
  ).map((l) => l.id);
}

/**
 * The managed libraries a program should have: those serving a component placed in the project
 * (for the program's language and profile), plus those its code still names (a library stays
 * while the code needs it, even when its component is removed), with their dependencies. Pinned
 * versions already in `current` are kept as they are; anything new gets the registry's version.
 * Sorted by id. User code is never edited.
 */
export function resolveLibraries(doc: ProjectDocument, program: ProgramSource): LibraryRef[] {
  const language = program.language as ProgramLanguage;
  const types = new Set<string>(doc.components.map((c) => c.type));
  const byComponent = MANAGED_LIBRARIES.filter(
    (l) =>
      l.language === language &&
      l.profiles.includes(program.profile) &&
      l.components.some((t) => types.has(t)),
  ).map((l) => l.id);
  const texts = [program.text, ...(program.files ?? []).map((f) => f.text)];
  const byCode = texts.flatMap((t) => librariesNamedBy(language, t));
  const wanted = withDependencies([...new Set([...byComponent, ...byCode])]).filter((l) =>
    l.profiles.includes(program.profile),
  );
  const current = new Map((program.libraries ?? []).map((r) => [r.id, r.version]));
  return wanted
    .map((l) => ({ id: l.id, version: current.get(l.id) ?? l.version }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export type LibraryIssue =
  | { code: 'unknown_library'; id: string; version: string }
  | { code: 'library_language'; id: string }
  | { code: 'library_profile'; id: string }
  | { code: 'library_dependency'; id: string; missing: string };

/** Why a program's pinned libraries cannot be built as they are (empty: they can). */
export function libraryIssues(program: ProgramSource): LibraryIssue[] {
  const issues: LibraryIssue[] = [];
  const ids = new Set((program.libraries ?? []).map((r) => r.id));
  for (const r of program.libraries ?? []) {
    const lib = managedLibrary(r.id, r.version);
    if (!lib) issues.push({ code: 'unknown_library', id: r.id, version: r.version });
    else if (lib.language !== program.language) issues.push({ code: 'library_language', id: r.id });
    else if (!lib.profiles.includes(program.profile))
      issues.push({ code: 'library_profile', id: r.id });
    else
      for (const d of lib.dependencies)
        if (!ids.has(d)) issues.push({ code: 'library_dependency', id: r.id, missing: d });
  }
  return issues;
}

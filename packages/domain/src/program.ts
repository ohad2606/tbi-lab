/**
 * Programs (Sprint 7): the authored source a board runs, and the build profiles that turn it
 * into a runnable artifact.
 *
 * The model is Project → Board → Programming environment (toolchain) → Source → Artifact →
 * Runtime. Arduino/C++ for the Classic ESP32 is the first environment; the types keep the
 * environment and its pinned configuration (the *profile*) explicit so that other environments
 * (MicroPython, ESP-IDF, other boards) can be added as further profiles. Nothing here equates
 * "build" or "program" with Arduino.
 *
 * A program is authored project data (language-neutral, stored exactly). Build results, artifact
 * identities and runtime state are never project data.
 */
import { canonicalJson } from './canonical.js';
import type { LibraryRef, ProgramFile, ProgramSource } from './schema.js';
import { sha256Utf8 } from './sha256.js';

/**
 * Programming environments. V1 ships `arduino-cpp`; Sprint 19B adds `micropython` (the genuine
 * MicroPython interpreter for the classic ESP32: the program is delivered to it, never translated).
 */
export type ProgramLanguage = 'arduino-cpp' | 'micropython';

export interface BuildProfile {
  /** Stable id; a change of any pinned input gets a new id (the id is part of the source key). */
  id: string;
  /** Board component type the profile targets. */
  board: string;
  language: ProgramLanguage;
  /** The one source file the environment expects (V1: a single file). */
  fileName: string;
  /** Maximum source size in UTF-8 bytes. */
  maxSourceBytes: number;
  /** Human-facing toolchain identity (technical, not translated). */
  toolchain: string;
}

/** Classic ESP32 + Arduino/C++ with the pinned R1 toolchain (arduino-cli 1.5.1, core 3.3.12). */
export const ESP32_ARDUINO_PROFILE: BuildProfile = {
  id: 'esp32-arduino-3.3.12',
  board: 'board.esp32_devkitc_wroom32',
  language: 'arduino-cpp',
  fileName: 'sketch.ino',
  maxSourceBytes: 64 * 1024,
  toolchain: 'arduino-esp32 3.3.12 · arduino-cli 1.5.1',
};

/**
 * Sprint 19B (MicroPython M1): the unmodified MicroPython ESP32_GENERIC v1.29.0 interpreter; "build"
 * writes `main.py` into its own LittleFS partition (runtime/micropython/tbi-mklfs.c).
 */
export const ESP32_MICROPYTHON_PROFILE: BuildProfile = {
  id: 'esp32-micropython-1.29',
  board: 'board.esp32_devkitc_wroom32',
  language: 'micropython',
  fileName: 'main.py',
  maxSourceBytes: 64 * 1024,
  toolchain: 'MicroPython v1.29.0 (ESP32_GENERIC)',
};

export const BUILD_PROFILES: readonly BuildProfile[] = [
  ESP32_ARDUINO_PROFILE,
  ESP32_MICROPYTHON_PROFILE,
];

export function profileById(id: string): BuildProfile | undefined {
  return BUILD_PROFILES.find((p) => p.id === id);
}

/** The build profile a board type uses by default (V1: the Arduino profile for the ESP32). */
export function defaultProfileForBoard(boardType: string): BuildProfile | undefined {
  return BUILD_PROFILES.find((p) => p.board === boardType);
}

/**
 * Content key of a build input: equal profile and equal file bytes give an equal key, in the
 * browser and in the build service alike. Used to match a build to the current source (a stale
 * build has a different key) and to find an existing build without building again.
 */
export function sourceKey(
  profile: string,
  files: readonly { name: string; text: string }[],
  /**
   * Sprint 26: the managed libraries of the build, with the checksum of each pinned source tree.
   * Part of the key only when there are any, so every earlier key stays what it was.
   */
  libraries: readonly { id: string; version: string; tree: string }[] = [],
): string {
  const input = {
    profile,
    files: [...files]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((f) => ({ name: f.name, sha256: sha256Utf8(f.text) })),
    ...(libraries.length
      ? {
          libraries: [...libraries]
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            .map((l) => ({ id: l.id, version: l.version, tree: l.tree })),
        }
      : {}),
  };
  return sha256Utf8(canonicalJson(input));
}

/**
 * Sprint 26: limits of a program's file set (the entry file included). The build protocol carries
 * at most 16 files; each within the profile's per-file limit; all together at most 256 KiB.
 */
export const PROGRAM_LIMITS = {
  maxFiles: 16,
  maxTotalBytes: 256 * 1024,
  maxPathLength: 96,
  maxDepth: 3,
} as const;

/**
 * Sprint 26: which project files an environment builds, by extension. Arduino compiles the sketch
 * folder's own files and, recursively, its `src/` folder (arduino-cli sketch specification);
 * MicroPython imports modules and packages from its file system.
 */
const FILE_RULES: Record<ProgramLanguage, { root: RegExp; nested: RegExp | null }> = {
  'arduino-cpp': { root: /\.(ino|cpp|c|h|hpp)$/, nested: /^src\/.+\.(cpp|c|h|hpp)$/ },
  micropython: { root: /\.py$/, nested: /\.py$/ },
};

/** A path segment: a portable file or folder name (no dot files, no `.`/`..`, no spaces). */
const SEGMENT = /^[A-Za-z_][A-Za-z0-9_-]{0,47}(\.[A-Za-z0-9]{1,4})?$/;
/** A MicroPython module or package segment must be a Python identifier to be importable. */
const PY_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]{0,47}(\.[A-Za-z0-9]{1,4})?$/;

export type ProgramPathIssue =
  | 'empty'
  | 'too_long'
  | 'bad_name'
  | 'too_deep'
  | 'bad_extension'
  | 'entry'
  | 'reserved'
  | 'duplicate';

/**
 * Sprint 26: why a relative path cannot name a further file of a program in `language` (null: it
 * can). Paths are `/`-separated, relative, without `.`/`..` segments, empty segments, backslashes,
 * dot files or names that differ only in case from another file (`taken`); never the entry file.
 * The same rules are enforced by the build service before any file is written.
 */
export function programPathIssue(
  language: ProgramLanguage,
  path: string,
  taken: readonly string[] = [],
  entry = language === 'micropython' ? 'main.py' : 'sketch.ino',
): ProgramPathIssue | null {
  if (!path) return 'empty';
  if (path.length > PROGRAM_LIMITS.maxPathLength) return 'too_long';
  const parts = path.split('/');
  if (parts.length > PROGRAM_LIMITS.maxDepth) return 'too_deep';
  const seg = language === 'micropython' ? PY_SEGMENT : SEGMENT;
  if (parts.some((p, i) => !seg.test(p) || (i < parts.length - 1 && p.includes('.'))))
    return 'bad_name';
  const lower = path.toLowerCase();
  if (lower === entry.toLowerCase()) return 'entry';
  const rules = FILE_RULES[language];
  if (parts.length === 1 ? !rules.root.test(path) : !rules.nested?.test(path))
    return 'bad_extension';
  // Arduino: the sketch folder's name is the entry's; a second `sketch.*` primary file, and the
  // build service's own folders, are reserved. MicroPython: boot.py would run before main.py.
  if (language === 'arduino-cpp' && /^sketch\./.test(lower)) return 'reserved';
  if (language === 'micropython' && lower === 'boot.py') return 'reserved';
  if (taken.some((t) => t.toLowerCase() === lower)) return 'duplicate';
  return null;
}

/** Sprint 26: every file of a program, entry first, as the build protocol carries them. */
export function programBuildFiles(program: ProgramSource): { name: string; text: string }[] {
  return [
    { name: program.fileName, text: program.text },
    ...(program.files ?? []).map((f) => ({ name: f.path, text: f.text })),
  ];
}

/** Sprint 26: the further files sorted by path (the stored order: deterministic save). */
export function sortProgramFiles(files: readonly ProgramFile[]): ProgramFile[] {
  return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Sprint 26: libraries sorted by id (the stored order). */
export function sortLibraryRefs(libs: readonly LibraryRef[]): LibraryRef[] {
  return [...libs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The program a newly placed board starts with (a product template, not user content). */
export function starterProgram(boardType: string): ProgramSource | undefined {
  const profile = defaultProfileForBoard(boardType);
  if (!profile) return undefined;
  return {
    language: profile.language,
    profile: profile.id,
    fileName: profile.fileName,
    text: STARTER_SOURCE[profile.language],
  };
}

/** The starter source of a programming environment (a product template, not user content). */
export function starterSourceFor(language: ProgramLanguage): string {
  return STARTER_SOURCE[language];
}

const STARTER_SOURCE: Record<ProgramLanguage, string> = {
  'arduino-cpp': 'void setup() {\n  // runs once\n}\n\nvoid loop() {\n  // runs repeatedly\n}\n',
  // Sprint 19B: main.py runs once when the board starts (a loop goes in the program itself).
  micropython:
    '# main.py runs once when the board starts.\nimport time\n\nwhile True:\n    time.sleep(1)\n',
};

/** UTF-8 byte length of a string (source limits are in bytes). */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

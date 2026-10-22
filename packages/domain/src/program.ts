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
import type { ProgramSource } from './schema.js';
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
): string {
  const input = {
    profile,
    files: [...files]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((f) => ({ name: f.name, sha256: sha256Utf8(f.text) })),
  };
  return sha256Utf8(canonicalJson(input));
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

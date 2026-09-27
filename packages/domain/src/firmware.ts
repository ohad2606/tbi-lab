/**
 * Prebuilt firmware a Classic ESP32 project can run in Sprint 6.
 *
 * S6 does not build firmware (Arduino compilation is Sprint 7). A project selects one of these
 * PREBUILT, IMMUTABLE artifacts by its content identity: the sha256 of the 4 MiB flash image the
 * runtime R1 provisioning produces (runtime/firmware/artifacts.lock.json). The Session Host
 * verifies that identity before every session and runs a private writable copy; the browser
 * never uploads or stores firmware bytes, and the package format's `firmware` section stays
 * null (it is reserved for embedding artifact bytes, which S6 does not do).
 *
 * Every entry is language-neutral data. Its display name and description are translation keys.
 * `features` is the firmware's declaration of features V1 does not simulate (internal pulls,
 * GPIO interrupts): the Session Host refuses a session that declares any, instead of running it
 * with silently dead behaviour. S7 will produce this declaration from the build; for the curated
 * S6 artifacts it is written here from their reviewed sources.
 */
import type { ComponentTypeId } from './schema.js';

export interface FirmwareArtifact {
  /** Stable language-neutral id. */
  id: string;
  /** Content identity: sha256 of the flash image (lowercase hex). */
  sha256: string;
  board: ComponentTypeId;
  nameKey: string;
  descriptionKey: string;
  /** Pins the firmware drives / reads (documentation for the inspector, not enforcement). */
  outputs: readonly number[];
  inputs: readonly number[];
  /** Declared unsupported features: empty for every curated S6 artifact. */
  features: { internalPull: readonly number[]; gpioInterrupt: readonly number[] };
  /** Where the image comes from (reviewed source in this repository). */
  source: string;
}

export const ESP32_BOARD: ComponentTypeId = 'board.esp32_devkitc_wroom32';

export const FIRMWARE_ARTIFACTS: readonly FirmwareArtifact[] = [
  {
    id: 'tbi-gpio-proof',
    sha256: '5f177cbe95f490dce1f6efe7dda501e03762d523b79771968f967b297d3a44af',
    board: ESP32_BOARD,
    nameKey: 'firmware.tbi-gpio-proof.name',
    descriptionKey: 'firmware.tbi-gpio-proof.description',
    outputs: [2, 18],
    inputs: [5],
    features: { internalPull: [], gpioInterrupt: [] },
    source: 'runtime/firmware/arduino/TbiGpioProof',
  },
  {
    id: 'tbi-banks',
    sha256: '9ca3a5cea66e46a2b54f14f38e0b065f36bc8cf70398cc88fae421028930a03d',
    board: ESP32_BOARD,
    nameKey: 'firmware.tbi-banks.name',
    descriptionKey: 'firmware.tbi-banks.description',
    outputs: [4, 16, 27, 25, 32, 33],
    inputs: [34, 35, 36, 39],
    features: { internalPull: [], gpioInterrupt: [] },
    source: 'runtime/firmware/arduino/TbiBanks',
  },
];

/** The project value meaning "no firmware selected". */
export const NO_FIRMWARE = 'none';
/**
 * The board runs its authored program (schema v3, Sprint 7): the artifact is the current build of
 * `programs[boardId]`. The pinned artifacts above stay as reference images for examples, tests and
 * engineering (not the normal firmware choice).
 */
export const PROGRAM_FIRMWARE = 'program';

export function firmwareBySha(sha256: string): FirmwareArtifact | undefined {
  return FIRMWARE_ARTIFACTS.find((f) => f.sha256 === sha256);
}

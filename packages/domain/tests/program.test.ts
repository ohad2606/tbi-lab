/** Programs and build profiles (Sprint 7): the shared source key and profile registry. */
import { describe, expect, it } from 'vitest';
import {
  ESP32_ARDUINO_PROFILE,
  defaultProfileForBoard,
  profileById,
  sourceKey,
  utf8Length,
} from '../src/index.js';

describe('sourceKey', () => {
  it('is stable, depends on profile and exact bytes, not on file order', () => {
    const a = sourceKey('esp32-arduino-3.3.12', [{ name: 'sketch.ino', text: 'void setup(){}' }]);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(
      sourceKey('esp32-arduino-3.3.12', [{ name: 'sketch.ino', text: 'void setup(){}' }]),
    ).toBe(a);
    expect(
      sourceKey('esp32-arduino-3.3.12', [{ name: 'sketch.ino', text: 'void setup(){} ' }]),
    ).not.toBe(a);
    expect(sourceKey('other-profile', [{ name: 'sketch.ino', text: 'void setup(){}' }])).not.toBe(
      a,
    );
    const files = [
      { name: 'main.py', text: 'print(1)' },
      { name: 'boot.py', text: '' },
    ];
    expect(sourceKey('p', files)).toBe(sourceKey('p', [...files].reverse()));
    // Unicode text (comments may be in any language) is keyed by its UTF-8 bytes.
    expect(sourceKey('p', [{ name: 'a', text: '// שלום' }])).not.toBe(
      sourceKey('p', [{ name: 'a', text: '// שלוםx' }]),
    );
  });
});

describe('profiles', () => {
  it('the Classic ESP32 uses the pinned Arduino/C++ profile by default', () => {
    expect(defaultProfileForBoard('board.esp32_devkitc_wroom32')).toBe(ESP32_ARDUINO_PROFILE);
    expect(profileById('esp32-arduino-3.3.12')).toBe(ESP32_ARDUINO_PROFILE);
    expect(ESP32_ARDUINO_PROFILE).toMatchObject({
      language: 'arduino-cpp',
      fileName: 'sketch.ino',
      maxSourceBytes: 65536,
    });
    expect(profileById('nope')).toBeUndefined();
    expect(utf8Length('אב')).toBe(4);
  });
});

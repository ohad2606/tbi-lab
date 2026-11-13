/**
 * P1 (owner report, 2026-11-01): the ESP32 ultrasonic distance alarm's Arduino code was gone after
 * Arduino -> MicroPython -> Arduino. Root cause: switching replaced the program with the other
 * language's starter (edit.ts setProgramProfile) and autosave persisted the replacement. These
 * tests drive the app store with real persistence (fake IndexedDB) and the real example data.
 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import {
  ESP32_ARDUINO_PROFILE,
  ESP32_MICROPYTHON_PROFILE,
  createPackage,
  serializePackage,
  setProgramProfile,
  setProgramText,
  starterSourceFor,
  validateProject,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { EXAMPLE_VARIANTS, circuitKey, loadExampleDocument } from '../src/examples/catalog.js';
import { ProjectStore } from '../src/persistence/store.js';
import { AppStore, type Preferences } from '../src/state/app.js';

const prefs = (): Preferences => {
  const data: Record<string, string> = {};
  return { get: (k) => data[k] ?? null, set: (k, v) => void (data[k] = v) };
};

async function setup() {
  let n = 0;
  const storage = await ProjectStore.open(new IDBFactory());
  const app = new AppStore({
    storage,
    prefs: prefs(),
    languages: ['en-US'],
    newId: () => `id${++n}`,
    autosaveDebounceMs: 1,
  });
  await app.init();
  return { app, storage };
}

const boardOf = (doc: ProjectDocument) => Object.keys(doc.programs)[0]!;
const active = (doc: ProjectDocument) => {
  const { alternates: _a, ...p } = doc.programs[boardOf(doc)]!;
  return p;
};
function switchTo(app: AppStore, profile: string): boolean {
  const doc = app.state.doc!;
  const r = setProgramProfile(doc, boardOf(doc), profile);
  expect(app.apply(r)).toBe(true);
  return r.ok && r.restored;
}
async function flush(app: AppStore) {
  await (app as unknown as { autosave: { flush(): Promise<void> } | null }).autosave?.flush();
}

describe('P1: switching the programming language never loses code', () => {
  // MicroPython expansion: every built-in ESP32 example now has a verified twin, so the owner's
  // sequence on a project WITHOUT one runs on the distance alarm as it was saved before twins
  // existed (an exported copy with no other-language code), imported.
  it('owner reproduction: an Arduino project without a twin survives MicroPython and back, saved and reloaded', async () => {
    const { app, storage } = await setup();
    const example = (await loadExampleDocument('esp32-distance-alarm'))!;
    const text = serializePackage(
      createPackage(example, { appVersion: '0', exportedAt: '2026-11-01T00:00:00.000Z' }),
    );
    expect(await app.importPackage(text)).toBe(true);
    const original = JSON.stringify(example.programs[boardOf(example)]);
    expect(JSON.stringify(active(app.state.doc!))).toBe(original);
    // No verified MicroPython version: the starter opens, said so (restored = false), Arduino kept.
    expect(switchTo(app, ESP32_MICROPYTHON_PROFILE.id)).toBe(false);
    expect(active(app.state.doc!).text).toBe(starterSourceFor('micropython'));
    await flush(app);
    const stored = (await storage.load(app.state.doc!.projectId)) as ProjectDocument;
    expect(JSON.stringify(stored.programs[boardOf(stored)]!.alternates![0])).toBe(original);
    // Back to Arduino: the example, byte for byte.
    expect(switchTo(app, ESP32_ARDUINO_PROFILE.id)).toBe(true);
    expect(JSON.stringify(active(app.state.doc!))).toBe(original);
    await flush(app);
    // Reload from storage.
    const id = app.state.doc!.projectId;
    await app.goHome();
    await app.openProject(id);
    expect(JSON.stringify(active(app.state.doc!))).toBe(original);
    expect(validateProject(app.state.doc!)).toEqual([]);
  });

  it('every declared twin pair shares exactly the same circuit', async () => {
    for (const [a, b] of Object.entries(EXAMPLE_VARIANTS)) {
      const da = (await loadExampleDocument(a))!;
      const db = (await loadExampleDocument(b))!;
      expect(circuitKey(da), `${a} vs ${b}`).toBe(circuitKey(db));
      expect(EXAMPLE_VARIANTS[b]).toBe(a);
      expect(active(da).profile).not.toBe(active(db).profile);
    }
  });

  it('an example with a verified twin switches to the twin’s exact code (libraries included) and back', async () => {
    for (const [arduino, mpy] of [
      ['esp32-blink', 'mpy-blink'],
      ['esp32-lcd-library', 'mpy-lcd-library'],
      ['esp32-distance-alarm', 'mpy-distance-alarm'],
      ['esp32-thermo-hygrometer', 'mpy-thermo-hygrometer'],
    ] as const) {
      const { app } = await setup();
      await app.openExample(arduino);
      const a = JSON.stringify(active(app.state.doc!));
      const twin = (await loadExampleDocument(mpy))!;
      expect(switchTo(app, ESP32_MICROPYTHON_PROFILE.id)).toBe(true);
      expect(JSON.stringify(active(app.state.doc!))).toBe(
        JSON.stringify(twin.programs[boardOf(twin)]),
      );
      expect(switchTo(app, ESP32_ARDUINO_PROFILE.id)).toBe(true);
      expect(JSON.stringify(active(app.state.doc!))).toBe(a);
    }
    // And from the MicroPython side.
    const { app } = await setup();
    await app.openExample('mpy-fade');
    expect(switchTo(app, ESP32_ARDUINO_PROFILE.id)).toBe(true);
    const fade = (await loadExampleDocument('esp32-led-fade'))!;
    expect(active(app.state.doc!).text).toBe(fade.programs[boardOf(fade)]!.text);
  });

  it('a modified built-in example keeps the user’s edit, not the curated default; unsaved edits too', async () => {
    const { app, storage } = await setup();
    await app.openExample('esp32-blink');
    const doc = app.state.doc!;
    const edited = active(doc).text.replace('delay(500)', 'delay(250)') + '// mine\n';
    expect(app.apply(setProgramText(doc, boardOf(doc), edited))).toBe(true);
    // Switch at once, before the autosave has run.
    switchTo(app, ESP32_MICROPYTHON_PROFILE.id);
    switchTo(app, ESP32_ARDUINO_PROFILE.id);
    expect(active(app.state.doc!).text).toBe(edited);
    await flush(app);
    const stored = (await storage.load(app.state.doc!.projectId)) as ProjectDocument;
    expect(active(stored).text).toBe(edited);
  });

  it('export and import keep both languages exactly', async () => {
    const { app } = await setup();
    await app.openExample('esp32-lcd-library');
    switchTo(app, ESP32_MICROPYTHON_PROFILE.id);
    const before = app.state.doc!.programs[boardOf(app.state.doc!)]!;
    const text = serializePackage(
      createPackage(app.state.doc!, { appVersion: '0', exportedAt: '2026-11-01T00:00:00.000Z' }),
    );
    expect(await app.importPackage(text)).toBe(true);
    const imported = app.state.doc!;
    expect(JSON.stringify(imported.programs[boardOf(imported)])).toBe(JSON.stringify(before));
    switchTo(app, ESP32_ARDUINO_PROFILE.id);
    const lib = (await loadExampleDocument('esp32-lcd-library'))!;
    expect(JSON.stringify(active(app.state.doc!))).toBe(JSON.stringify(lib.programs[boardOf(lib)]));
  });

  it('undo after a switch returns to the state before it', async () => {
    const { app } = await setup();
    await app.openExample('esp32-distance-alarm');
    const before = JSON.stringify(app.state.doc!.programs);
    switchTo(app, ESP32_MICROPYTHON_PROFILE.id);
    app.undo();
    expect(JSON.stringify(app.state.doc!.programs)).toBe(before);
  });
});

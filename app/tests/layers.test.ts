/**
 * 3D visualization layers (Sprint 10, owner-approved): presets, the manual toggle, the view
 * preference (never project data), and the Labels layer's anchors.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ProjectDocument } from '@tbi-lab/domain';
import { en } from '../src/i18n/messages.en.js';
import { he } from '../src/i18n/messages.he.js';
import { deriveScene, MODEL_HEIGHT } from '../src/views/scene3d/scene.js';
import {
  DEFAULT_PRESET,
  LAYERS,
  LAYERS_KEY,
  PRESETS,
  labelAnchors,
  matchPreset,
  presetVisibility,
  readLayers,
  writeLayers,
} from '../src/views/scene3d/layers.js';

const memory = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    m,
  };
};

describe('visualization layers', () => {
  it('Realistic (the default) hides labels and grid; Engineering shows them', () => {
    expect(DEFAULT_PRESET).toBe('realistic');
    expect(presetVisibility('realistic')).toEqual({ labels: false, grid: false, dof: true });
    expect(presetVisibility('engineering')).toEqual({ labels: true, grid: true, dof: false });
    expect(matchPreset(presetVisibility('realistic'))).toBe('realistic');
    expect(matchPreset(presetVisibility('engineering'))).toBe('engineering');
  });

  it('a manual toggle leaves the presets ("custom") and is stored as a view preference only', () => {
    const v = { ...presetVisibility('realistic'), labels: true };
    expect(matchPreset(v)).toBe('custom');
    const s = memory();
    writeLayers(s, v);
    expect([...s.m.keys()]).toEqual([LAYERS_KEY]);
    expect(readLayers(s)).toEqual(v);
  });

  it('a fresh browser, junk or unknown keys give the default preset', () => {
    expect(readLayers(memory())).toEqual(presetVisibility('realistic'));
    const s = memory();
    s.setItem(LAYERS_KEY, '{not json');
    expect(readLayers(s)).toEqual(presetVisibility('realistic'));
    s.setItem(LAYERS_KEY, JSON.stringify({ labels: 'yes', debug: true }));
    expect(readLayers(s)).toEqual(presetVisibility('realistic'));
    expect(readLayers(null)).toEqual(presetVisibility('realistic'));
  });

  it('every layer and preset is named in English and Hebrew', () => {
    for (const k of [
      ...LAYERS.map((l) => l.titleKey),
      ...PRESETS.map((p) => p.titleKey),
      'view3d.mode' as const,
      'view3d.layers.lens' as const,
      'view3d.dof.unavailable' as const,
    ]) {
      expect(en[k]).toBeTruthy();
      expect(he[k]).toBeTruthy();
      expect(he[k]).not.toBe(en[k]);
    }
  });

  it('visual mode (realism pass 8): Realistic draws depth of field, Engineering keeps all sharp', () => {
    expect(PRESETS.map((p) => p.id)).toEqual(['realistic', 'engineering']);
    expect(LAYERS.find((l) => l.id === 'dof')).toMatchObject({
      kind: 'lens',
      presets: { realistic: true, engineering: false },
    });
    // Turning depth of field off by hand from Realistic is "custom", not Engineering.
    expect(matchPreset({ ...presetVisibility('realistic'), dof: false })).toBe('custom');
    // Persisted per browser, in the view preference only.
    const s = memory();
    writeLayers(s, presetVisibility('engineering'));
    expect(readLayers(s)).toEqual(presetVisibility('engineering'));
    writeLayers(s, presetVisibility('realistic'));
    expect(readLayers(s)).toEqual(presetVisibility('realistic'));
    expect([...s.m.keys()]).toEqual([LAYERS_KEY]);
  });

  it('a preference stored before depth of field existed keeps its preset', () => {
    const s = memory();
    s.setItem(LAYERS_KEY, JSON.stringify({ labels: true, grid: true }));
    expect(matchPreset(readLayers(s))).toBe('engineering');
    s.setItem(LAYERS_KEY, JSON.stringify({ labels: false, grid: false }));
    expect(matchPreset(readLayers(s))).toBe('realistic');
    s.setItem(LAYERS_KEY, JSON.stringify({ labels: true, grid: false }));
    expect(readLayers(s)).toEqual({ labels: true, grid: false, dof: true });
  });

  it('labels name the right parts: one per part, above it, ids unchanged in every locale', () => {
    const doc = JSON.parse(
      readFileSync(new URL('../src/examples/data/esp32-bench.json', import.meta.url), 'utf8'),
    ) as ProjectDocument;
    const before = JSON.stringify(doc);
    const desc = deriveScene(doc);
    const anchors = labelAnchors(desc);
    expect(anchors.map((a) => a.id)).toEqual(desc.components.map((c) => c.id));
    for (const a of anchors) {
      const c = desc.components.find((x) => x.id === a.id)!;
      expect([a.x, a.z]).toEqual([c.x, c.z]);
      expect(a.y).toBeGreaterThan(MODEL_HEIGHT[c.model]);
    }
    // Deriving the layers never touches the project.
    expect(JSON.stringify(doc)).toBe(before);
  });
});

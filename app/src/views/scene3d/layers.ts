/**
 * 3D visualization layers (Sprint 10, owner-approved): the PHYSICAL scene (parts, PCB, wires,
 * connectors, the mat, switch positions, LED emission) is always drawn; ENGINEERING information is
 * an optional layer over it, never printed into the physical scene. Pure: no WebGL, no DOM.
 *
 * A layer has a stable id, a localized name and a default per preset. The renderer gives each a
 * render hook (renderer.ts): scene content tagged `userData.layer = <id>` (the grid) is shown or
 * hidden as a group; an overlay layer (labels) builds, updates while visible, and disposes itself.
 * Future layers (electrical values, net/current visualization, simulation state, warnings, debug)
 * are added here and register a hook; nothing else in the scene builder changes.
 *
 * Visibility is a VIEW preference (localStorage, per browser): never project data, never part of
 * the electrical schema; changing it rebuilds nothing and restarts nothing.
 */
import type { MessageKey } from '../../i18n/messages.en.js';
import { MODEL_HEIGHT, type SceneDescription } from './scene.js';

export type LayerId = 'labels' | 'grid';
export type PresetId = 'realistic' | 'engineering';
export type LayerVisibility = Record<LayerId, boolean>;

export interface LayerDef {
  id: LayerId;
  titleKey: MessageKey;
  /** Visible by default in each preset. */
  presets: Record<PresetId, boolean>;
}

/** The registered layers, in menu order. */
export const LAYERS: readonly LayerDef[] = [
  {
    id: 'labels',
    titleKey: 'view3d.layer.labels',
    presets: { realistic: false, engineering: true },
  },
  { id: 'grid', titleKey: 'view3d.layer.grid', presets: { realistic: false, engineering: true } },
];

export const PRESETS: readonly { id: PresetId; titleKey: MessageKey }[] = [
  { id: 'realistic', titleKey: 'view3d.preset.realistic' },
  { id: 'engineering', titleKey: 'view3d.preset.engineering' },
];

/** The preset a fresh browser starts with: the physical scene alone. */
export const DEFAULT_PRESET: PresetId = 'realistic';

export function presetVisibility(preset: PresetId): LayerVisibility {
  return Object.fromEntries(LAYERS.map((l) => [l.id, l.presets[preset]])) as LayerVisibility;
}

/** The preset a visibility set equals, or 'custom' after a manual change. */
export function matchPreset(v: LayerVisibility): PresetId | 'custom' {
  for (const p of PRESETS) {
    const want = presetVisibility(p.id);
    if (LAYERS.every((l) => want[l.id] === v[l.id])) return p.id;
  }
  return 'custom';
}

export const LAYERS_KEY = 'tbi-lab.3d.layers';

/** The stored view preference, or the default preset's (unknown keys and junk are ignored). */
export function readLayers(storage: Pick<Storage, 'getItem'> | null): LayerVisibility {
  const base = presetVisibility(DEFAULT_PRESET);
  try {
    const raw = storage?.getItem(LAYERS_KEY);
    if (!raw) return base;
    const v = JSON.parse(raw) as Record<string, unknown>;
    for (const l of LAYERS) if (typeof v[l.id] === 'boolean') base[l.id] = v[l.id] as boolean;
  } catch {
    /* unreadable: the default */
  }
  return base;
}

export function writeLayers(storage: Pick<Storage, 'setItem'> | null, v: LayerVisibility): void {
  try {
    storage?.setItem(LAYERS_KEY, JSON.stringify(v));
  } catch {
    /* storage unavailable: this session only */
  }
}

/** A reference annotation floats this far above its part's top (mm). */
export const LABEL_LIFT = 2.5;

/**
 * The Labels layer's anchors: one per part, its reference designator just above the part's top,
 * at the part's FINAL position in the scene (after any visual separation), so an annotation always
 * names the part under it. Language-neutral ids (R1, U1): the same in every locale.
 */
export function labelAnchors(
  desc: SceneDescription,
): { id: string; x: number; y: number; z: number }[] {
  return desc.components.map((c) => ({
    id: c.id,
    x: c.x,
    y: MODEL_HEIGHT[c.model] + LABEL_LIFT,
    z: c.z,
  }));
}

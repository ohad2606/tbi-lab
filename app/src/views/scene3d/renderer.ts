/**
 * The 3D viewer (Sprint 9, D-S9-3). Loaded on demand (dynamic import from ThreeView), so three.js
 * never enters the main bundle.
 *
 * - Renders ON DEMAND: after a scene update, a resize or a camera change. There is no animation
 *   loop; nothing runs while the view is idle or closed.
 * - Every geometry, material and texture it creates is owned and released: a rebuild disposes the
 *   previous build; `dispose()` releases everything, including the WebGL context.
 * - Navigation (OrbitControls): rotate a full 360° around the circuit, zoom, pan (right or middle
 *   drag, two fingers, Shift + arrow keys). Fit and Reset re-centre on the circuit. It never edits
 *   anything: the viewer has no access to the project, only to a scene description.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  buildComponent,
  createMaterials,
  OwnedResources,
  paintLcdFace,
  paintMatrixFace,
  type LcdFace,
} from './models.js';
import { assetLoadStats, loadAssets } from './assets/library.js';
import { createStage } from './stage.js';
import { chooseQuality, probeGpu } from '../../gpuInfo.js';
import { bentPath, buildJoint, buildSplice, buildWire, wireMaterials } from './wires.js';
import { shapeWires, type WireShape } from './wireShape.js';
import { familyOf, variationAttribute, variedMaterial } from './variation.js';

export { assetLoadStats, loadAssets };
import { MODEL_HEIGHT, type SceneDescription, type Vec3 } from './scene.js';
import { footprintRect } from './labels.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { DEFAULT_PRESET, labelAnchors, presetVisibility, type LayerVisibility } from './layers.js';
import type { Ray } from './pick.js';
import { TOGGLE_TILT } from './assets/benchParts.js';

/** LED light pool size and the light's intensity per unit live level (mm scene, decay 2). */
const LED_LIGHTS = 4;
const LED_LIGHT = 90;
/** Fit/reset: the content's projected box spans this fraction of the view (NDC half-extent). */
// Realism pass 5: 0.88 now that the fit measures the parts and wires themselves (not the bounding
// box), leaving room for the view's help note at the bottom edge.
const FRAME_FILL = 0.88;

export interface ViewerStats {
  /** Rendering quality chosen for this device (see RenderQuality). */
  quality: RenderQuality;
  geometries: number;
  textures: number;
  objects: number;
  renders: number;
  /**
   * Estimated GPU memory of the current scene, bytes: vertex/index buffers of every drawn
   * geometry (shared ones counted once) and textures (RGBA8, with mipmaps). An estimate from the
   * CPU-side sizes; drivers may pad.
   */
  gpuBytes: { geometry: number; textures: number };
  /** CPU time of the last frame's render call, ms (on software WebGL this is the whole cost). */
  renderMs: number;
  /** The camera's orbit target (what pan moves), rounded to 0.01 scene units. */
  target: [number, number, number];
  /** Last frame: draw calls and triangles (WebGLRenderer.info), and the scene's distinct materials. */
  drawCalls: number;
  triangles: number;
  materials: number;
  /** Shader programs compiled in this viewer's context. */
  programs: number;
  /**
   * Depth of field: drawn (`on`), turned off by the view (`off`), or not available in this tier
   * (`unavailable`: the reduced tier renders everything sharp).
   */
  dof: 'on' | 'off' | 'unavailable';
  /** This viewer's WebGL renderer (the GPU, or a software rasteriser) and its pixel ratio. */
  gpu: string;
  pixelRatio: number;
}

export interface Viewer {
  update(scene: SceneDescription, opts?: { resetCamera?: boolean }): void;
  /**
   * Live presentation state while a simulation runs: LED glow level 0..1 per component id (the
   * same visual cue as the circuit view: full at 20 mA). Never an electrical input.
   */
  /**
   * Live emission per LED component: a level in [0, 1], or for a part whose colour is itself a
   * result (an RGB LED's mix of solved channel currents) a level and a colour.
   */
  setLive(levels: Record<string, LiveLevel>): void;
  resetCamera(): void;
  /**
   * Frame the whole circuit from a standard direction (camera ergonomics, Sprint 10): straight
   * from above, from the front or the side at a low angle, or from the rear.
   */
  view(preset: ViewPreset): void;
  /** Frame the whole circuit from the current viewing direction. */
  fit(): void;
  rotate(radians: number): void;
  zoom(factor: number): void;
  /**
   * Move the view (camera and target together) by a fraction of the visible height, right and
   * up on screen: the same motion as a right- or middle-button drag.
   */
  pan(right: number, up: number): void;
  /**
   * Evidence capture and close inspection: put the camera at `from`, looking at `target` (scene
   * mm). Camera only; never part of the project.
   */
  inspect(target: [number, number, number], from: [number, number, number]): void;
  /** The ray through a point of the view (client pixels), for picking (pick.ts). */
  rayAt(clientX: number, clientY: number): Ray;
  /** Where a scene point appears, client pixels (tests, evidence). */
  screenOf(p: [number, number, number]): { x: number; y: number };
  /** The wires' drawn shapes of the current scene (picking hits what is drawn). */
  wireShapes(): ReadonlyMap<string, WireShape>;
  /**
   * The project selection, shown subtly: a thin ring on the bench round a selected part, a faint
   * sleeve along a selected wire. Presentation only.
   */
  setSelection(sel: { components: readonly string[]; wires: readonly string[] }): void;
  /**
   * The physical controls' state (the document's switch positions, the session's pressed
   * buttons: the same state the Circuit view shows): each actuator moves to match, the lever
   * swinging about its pivot, the button's cap travelling down. Animated briefly (instant when
   * the user prefers reduced motion); frames are drawn only while something moves.
   */
  setControls(state: {
    closed: Readonly<Record<string, boolean>>;
    pressed: readonly string[];
  }): void;
  /** Each actuator's current pose (lever tilt, rad; cap height, mm): tests and evidence. */
  poses(): Record<string, number>;
  stats(): ViewerStats;
  /**
   * Which visualization layers show (layers.ts: a view preference, never project data). Changing
   * it rebuilds nothing: tagged scene content is shown or hidden, overlays stop updating.
   */
  setLayers(visible: LayerVisibility): void;
  dispose(): void;
}

export type ViewPreset = 'top' | 'front' | 'side' | 'rear';

/** Viewing directions (from the target towards the camera) of the standard views. */
const PRESETS: Record<ViewPreset, [number, number, number]> = {
  // Straight down (a hair of +z keeps "up" on screen towards the 2D drawing's top edge).
  top: [0, 1, 0.0005],
  // Low angles: about 15 degrees above the bench, so leads, pins and wire heights read.
  front: [0, 0.27, 1],
  side: [1, 0.27, 0],
  rear: [0, 0.27, -1],
};

export class WebGLUnavailableError extends Error {}

/** Live viewers in this page (tests check that leaving the view releases its viewer). */
let live = 0;
export const liveViewers = () => live;

/**
 * Rendering quality. `full`: soft shadows from the key light and multisample antialiasing.
 * `reduced`: neither. Chosen per device: a SOFTWARE rasteriser (SwiftShader, llvmpipe, a "basic
 * render driver", as on GPU-less servers and CI) gets `reduced`, because there each shadow pass
 * and every MSAA sample is CPU work that costs about a second per opening; every real GPU gets
 * `full`. A per-browser override (localStorage `tbi-lab.3d.quality` = full | reduced) exists for
 * evidence capture and troubleshooting. The scene itself (parts, wires, colours) is identical.
 */
export type RenderQuality = 'full' | 'reduced';

export type LiveLevel =
  | number
  | { level: number; color: string }
  /** An LED matrix: each dot's level (0..1), row-major. */
  | { dots: number[] }
  /** A character LCD (Sprint 12): what the engine reports it shows. */
  | { lcd: LcdFace };
/** Re-exported for the tests: the tier choice lives in gpuInfo.ts (no three.js there). */
export { chooseQuality };

/** Whether WebGL works here, and which quality this device should get. */
function probeWebgl(): RenderQuality | null {
  return probeGpu()?.tier ?? null;
}

export function createViewer(
  container: HTMLElement,
  onRender?: (s: ViewerStats) => void,
  options: { layers?: LayerVisibility } = {},
): Viewer {
  let layers: LayerVisibility = { ...(options.layers ?? presetVisibility(DEFAULT_PRESET)) };
  const quality = probeWebgl();
  if (!quality) throw new WebGLUnavailableError('WebGL is not available');
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      // Full tier: the stage's multisampled frame does the antialiasing (stage.ts).
      antialias: false,
      powerPreference: quality === 'full' ? 'high-performance' : 'low-power',
    });
  } catch (e) {
    throw new WebGLUnavailableError((e as Error).message);
  }
  live++;
  const canvas = renderer.domElement;
  canvas.classList.add('view3d-canvas');
  canvas.setAttribute('aria-hidden', 'true');
  container.appendChild(canvas);

  // The Labels layer (layers.ts): reference annotations as screen-space UI over the canvas, not
  // objects in the physical scene. Their own scene; drawn only while the layer is visible.
  const tags = new CSS2DRenderer();
  tags.domElement.classList.add('view3d-tags');
  tags.domElement.setAttribute('aria-hidden', 'true');
  container.appendChild(tags.domElement);
  const tagScene = new THREE.Scene();
  function clearTags() {
    for (const o of [...tagScene.children]) {
      tagScene.remove(o);
      (o as CSS2DObject).element.remove();
    }
  }
  function buildTags(desc: SceneDescription) {
    clearTags();
    for (const a of labelAnchors(desc)) {
      const el = document.createElement('div');
      el.className = 'view3d-tag';
      el.dir = 'ltr';
      el.textContent = a.id;
      el.dataset.component = a.id;
      const tag = new CSS2DObject(el);
      tag.position.set(a.x, a.y, a.z);
      tagScene.add(tag);
    }
  }
  /** Tagged scene content (`userData.layer`) follows its layer's visibility. */
  function applyLayers() {
    content?.traverse((o) => {
      const id = o.userData.layer as keyof LayerVisibility | undefined;
      if (id) o.visible = layers[id] ?? false;
    });
    tags.domElement.style.display = layers.labels ? '' : 'none';
    // The lens (Realistic: depth of field; Engineering: all sharp). Camera and scene untouched.
    dofActive = stage.setDepthOfField(layers.dof);
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 2000);
  // Lights, environment, shadows, ambient occlusion, bench and backdrop: the stage (stage.ts).
  const stage = createStage(renderer, scene, camera, quality);
  /** Whether depth of field is drawn (full tier and the view asks for it). */
  let dofActive = stage.setDepthOfField(layers.dof);
  // The GPU this viewer actually renders on (development diagnostics; never sent anywhere).
  const gpu = (() => {
    try {
      const gl = renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return String(
        ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      );
    } catch {
      return '';
    }
  })();
  /**
   * LED light (full tier): a fixed pool of point lights, given to the brightest lit LEDs, so a lit
   * LED tints the bench and the parts round it. A fixed count: lighting an LED never recompiles a
   * shader. Presentation of the solved current only.
   */
  const ledLights =
    quality === 'full'
      ? Array.from({ length: LED_LIGHTS }, () => new THREE.PointLight('#ffffff', 0, 40, 2))
      : [];
  for (const l of ledLights) scene.add(l);

  /** `reduced` quality: standard stand-ins for physical materials, one per original (reused). */
  const simplified = new Map<THREE.Material, THREE.Material>();
  /** Full tier: the varied copy of each varied family's material (variation.ts), per viewer. */
  const varied = new Map<THREE.Material, THREE.Material>();
  const materials = createMaterials();
  const shared: THREE.Material[] = Object.values(materials);
  const soldermat = new THREE.MeshStandardMaterial({
    color: '#cfd4d9',
    metalness: 0.9,
    roughness: 0.25,
  });
  const haloTexture = glowTexture();
  shared.push(soldermat);

  let content: THREE.Group | null = null;
  /** Resources drawn once per viewer (board textures, atlases), kept across rebuilds. */
  const persistent = new OwnedResources(null, quality);
  let own = new OwnedResources(persistent, quality);
  let current: SceneDescription | null = null;
  let currentShapes: ReadonlyMap<string, WireShape> = new Map();
  let selected: { components: readonly string[]; wires: readonly string[] } = {
    components: [],
    wires: [],
  };
  let selectionGroup: THREE.Group | null = null;
  // Physical controls: each actuator (userData.actuator, tagged by the part builders) by part.
  let actuatorsById = new Map<string, { obj: THREE.Object3D; kind: string }>();
  let controls3d: { closed: Readonly<Record<string, boolean>>; pressed: readonly string[] } = {
    closed: {},
    pressed: [],
  };
  const tweens = new Map<
    THREE.Object3D,
    { prop: 'rot' | 'y'; from: number; to: number; start: number; ms: number }
  >();
  let animating = 0;
  const reducedMotion = () => {
    try {
      return matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  };
  /** Where an actuator belongs for the current control state. */
  function poseOf(id: string, a: { obj: THREE.Object3D; kind: string }) {
    if (a.kind === 'toggle')
      return {
        prop: 'rot' as const,
        // Not yet told: as built (from the scene's own state).
        to:
          id in controls3d.closed
            ? controls3d.closed[id]
              ? TOGGLE_TILT.closed
              : TOGGLE_TILT.open
            : a.obj.rotation.z,
      };
    const rest = a.obj.userData.restY as number;
    const travel = a.obj.userData.travel as number;
    return { prop: 'y' as const, to: controls3d.pressed.includes(id) ? rest - travel : rest };
  }
  const poseNow = (o: THREE.Object3D, prop: 'rot' | 'y') =>
    prop === 'rot' ? o.rotation.z : o.position.y;
  const set = (o: THREE.Object3D, prop: 'rot' | 'y', v: number) => {
    if (prop === 'rot') o.rotation.z = v;
    else o.position.y = v;
  };
  /** Move every actuator to its pose: animated (`animate`) or at once. */
  function applyControls(animate: boolean) {
    const now = performance.now();
    const instant = !animate || reducedMotion();
    for (const [id, a] of actuatorsById) {
      const { prop, to } = poseOf(id, a);
      const from = poseNow(a.obj, prop);
      if (Math.abs(from - to) < 1e-6) continue;
      if (instant) {
        set(a.obj, prop, to);
        tweens.delete(a.obj);
      } else {
        // Short, restrained mechanical movement: a lever swing, a button's travel.
        const ms = prop === 'rot' ? 150 : to < from ? 60 : 80;
        tweens.set(a.obj, { prop, from, to, start: now, ms });
      }
    }
    renderer.shadowMap.needsUpdate = true;
    if (tweens.size && !animating) animating = requestAnimationFrame(step);
    else requestRender();
  }
  function step(now: number) {
    animating = 0;
    if (disposed) return;
    for (const [o, t] of tweens) {
      const k = Math.min(1, (now - t.start) / t.ms);
      // Mechanical feel, no bounce: the lever starts slowly and snaps through its centre (ease-
      // in-out, an over-centre toggle); the cap goes down quickly (ease-out) and returns with a
      // soft ease-in-out. The state itself changed at once; only the pose follows.
      const down = t.prop === 'y' && t.to < t.from;
      const e = down ? 1 - (1 - k) ** 3 : k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2;
      set(o, t.prop, t.from + (t.to - t.from) * e);
      if (k >= 1) tweens.delete(o);
    }
    renderer.shadowMap.needsUpdate = true;
    render();
    if (tweens.size) animating = requestAnimationFrame(step);
  }
  const SELECT_COLOR = '#1565c0';
  /** Rebuild the selection marks (on a scene update or a selection change). */
  function drawSelection() {
    if (selectionGroup) {
      scene.remove(selectionGroup);
      selectionGroup.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry.dispose();
          (m.material as THREE.Material).dispose();
        }
      });
      selectionGroup = null;
    }
    if (!current || (!selected.components.length && !selected.wires.length)) return;
    const g = new THREE.Group();
    g.name = 'selection';
    const mat = (opacity: number) =>
      new THREE.MeshBasicMaterial({
        color: SELECT_COLOR,
        side: THREE.DoubleSide,
        transparent: true,
        opacity,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -4,
      });
    for (const id of selected.components) {
      const c = current.components.find((x) => x.id === id);
      if (!c) continue;
      // A thin ring on the bench, 1 mm round the part's footprint.
      const r = footprintRect(c);
      const pad = 1;
      const w = 0.45;
      const outer = new THREE.Shape();
      outer.moveTo(r.x0 - pad - w, r.z0 - pad - w);
      outer.lineTo(r.x1 + pad + w, r.z0 - pad - w);
      outer.lineTo(r.x1 + pad + w, r.z1 + pad + w);
      outer.lineTo(r.x0 - pad - w, r.z1 + pad + w);
      outer.closePath();
      const hole = new THREE.Path();
      hole.moveTo(r.x0 - pad, r.z0 - pad);
      hole.lineTo(r.x0 - pad, r.z1 + pad);
      hole.lineTo(r.x1 + pad, r.z1 + pad);
      hole.lineTo(r.x1 + pad, r.z0 - pad);
      hole.closePath();
      outer.holes.push(hole);
      const geo = new THREE.ShapeGeometry(outer);
      geo.rotateX(Math.PI / 2);
      const ring = new THREE.Mesh(geo, mat(0.85));
      ring.position.y = 0.04;
      ring.userData.selection = id;
      g.add(ring);
    }
    for (const id of selected.wires) {
      const shape = currentShapes.get(id);
      if (!shape) continue;
      // A faint sleeve round the wire, the wire's own colour showing through.
      const path = bentPath(shape.points, shape.radii, shape.arms);
      const geo = new THREE.TubeGeometry(
        path,
        Math.max(16, Math.ceil(path.getLength() / 1.5)),
        1.05,
        10,
        false,
      );
      const sleeve = new THREE.Mesh(geo, mat(0.3));
      sleeve.userData.selection = id;
      g.add(sleeve);
    }
    selectionGroup = g;
    scene.add(g);
  }
  let renders = 0;
  let lastRenderMs = 0;
  let lastCalls = 0;
  let lastTriangles = 0;
  /** LED lens materials by component id, and the last live levels applied to them. */
  let lenses = new Map<
    string,
    {
      lens: THREE.MeshStandardMaterial;
      die?: THREE.MeshStandardMaterial;
      core?: THREE.SpriteMaterial;
      coreObj?: THREE.Object3D;
      gain: number;
      /** Where its light comes from (the die), world space. */
      at: THREE.Vector3;
      color: string;
    }
  >();
  /** LED matrix faces by component id (canvas texture + material), repainted live. */
  let matrices = new Map<
    string,
    { texture: THREE.CanvasTexture; material: THREE.MeshStandardMaterial }
  >();
  /** Character LCD faces by component id (Sprint 12), repainted live from the engine's result. */
  let lcds = new Map<
    string,
    { texture: THREE.CanvasTexture; material: THREE.MeshStandardMaterial }
  >();
  let liveLevels: Record<string, LiveLevel> = {};
  /** Glow halos of the LEDs, by component id. */
  let halos = new Map<string, THREE.Sprite>();
  function applyLive() {
    // LED matrices: repaint the face from the dot levels (dark when nothing is live).
    for (const [id, face] of matrices) {
      const live = liveLevels[id];
      const dots =
        live && typeof live === 'object' && 'dots' in live ? live.dots : new Array(64).fill(0);
      const canvas = face.texture.image as HTMLCanvasElement;
      paintMatrixFace(canvas.getContext('2d')!, canvas.width, dots);
      face.texture.needsUpdate = true;
      const any = dots.some((d) => d > 0);
      face.material.emissive.set(any ? '#ffffff' : '#000000');
      face.material.emissiveIntensity = any ? 0.9 : 0;
    }
    // Character LCDs: blank and unlit unless the engine reports their content and backlight.
    for (const [id, face] of lcds) {
      const live = liveLevels[id];
      const lcd = live && typeof live === 'object' && 'lcd' in live ? live.lcd : undefined;
      const canvas = face.texture.image as HTMLCanvasElement;
      paintLcdFace(canvas.getContext('2d')!, canvas.width, canvas.height, lcd);
      face.texture.needsUpdate = true;
      face.material.emissive.set(lcd?.backlight ? '#ffffff' : '#000000');
      face.material.emissiveIntensity = lcd?.backlight ? 0.75 : 0;
    }
    // The light pool (full tier): the brightest lit LEDs light their surroundings.
    const lit: { level: number; at: THREE.Vector3; color: string }[] = [];
    for (const [id, { lens: mat, die, core, coreObj, gain, at, color }] of lenses) {
      const raw = liveLevels[id] ?? 0;
      if (typeof raw === 'object' && ('dots' in raw || 'lcd' in raw)) continue;
      const live = raw;
      const level = typeof live === 'number' ? live : live.level;
      // The die is the light source; the epoxy glows with the light it scatters (diffused lenses
      // more than clear ones). A coloured live mix (RGB) on a water-clear lens: weaker emission
      // so the hue reads, not white.
      mat.emissiveIntensity = level * (typeof live === 'number' ? gain : 0.9);
      if (die) die.emissiveIntensity = level * 6;
      // The glow core round the die: where the light visibly starts.
      if (core) {
        core.opacity = Math.min(1, level * 1.1);
        if (typeof live !== 'number') core.color.set(live.color);
        if (coreObj) coreObj.visible = level > 0;
      }
      const halo = halos.get(id);
      if (typeof live !== 'number') {
        mat.emissive.set(live.color);
        if (halo) (halo.material as THREE.SpriteMaterial).color.set(live.color);
      }
      if (halo) {
        halo.visible = level > 0;
        (halo.material as THREE.SpriteMaterial).opacity =
          (typeof live === 'number' ? 0.85 : 0.55) * level;
      }
      if (level > 0) lit.push({ level, at, color: typeof live === 'number' ? color : live.color });
    }
    lit.sort((a, b) => b.level - a.level);
    ledLights.forEach((light, i) => {
      const l = lit[i];
      light.intensity = l ? LED_LIGHT * l.level : 0;
      if (l) {
        light.position.copy(l.at);
        light.color.set(l.color);
      }
    });
  }
  let disposed = false;

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;
  controls.screenSpacePanning = true;
  // Left drag orbits, right OR middle drag pans, the wheel zooms; one finger orbits, two fingers
  // pan and pinch-zoom (OrbitControls' touch default).
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.PAN,
    RIGHT: THREE.MOUSE.PAN,
  };
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  controls.maxPolarAngle = Math.PI * 0.495; // stay above the base plane
  controls.addEventListener('change', () => requestRender());

  const stats = (): ViewerStats => {
    let objects = 0;
    content?.traverse(() => objects++);
    const seenGeo = new Set<THREE.BufferGeometry>();
    const seenTex = new Set<THREE.Texture>();
    let geometry = 0;
    let textures = 0;
    const mats = new Set<THREE.Material>();
    content?.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh && !(o as THREE.Sprite).isSprite) return;
      if (mesh.geometry && !seenGeo.has(mesh.geometry)) {
        seenGeo.add(mesh.geometry);
        for (const a of Object.values(mesh.geometry.attributes))
          geometry += (a as THREE.BufferAttribute).array.byteLength;
        geometry += mesh.geometry.index?.array.byteLength ?? 0;
      }
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (m) mats.add(m);
        for (const t of Object.values(m ?? {}))
          if ((t as THREE.Texture)?.isTexture && !seenTex.has(t as THREE.Texture)) {
            seenTex.add(t as THREE.Texture);
            const img = (t as THREE.Texture).image as { width?: number; height?: number } | null;
            if (img?.width && img.height) textures += Math.round(img.width * img.height * 4 * 1.33);
          }
      }
    });
    return {
      gpuBytes: { geometry, textures },
      renderMs: Math.round(lastRenderMs * 10) / 10,
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      objects,
      renders,
      quality,
      drawCalls: lastCalls,
      triangles: lastTriangles,
      materials: mats.size,
      programs: renderer.info.programs?.length ?? 0,
      dof: quality !== 'full' ? 'unavailable' : dofActive ? 'on' : 'off',
      gpu,
      pixelRatio: stage.pixelRatio,
      target: controls.target.toArray().map((v) => Math.round(v * 100) / 100) as [
        number,
        number,
        number,
      ],
    };
  };

  function render() {
    if (disposed) return;
    const t0 = performance.now();
    // Count every pass of the frame (shadow, AO, beauty, output), not only the last one.
    renderer.info.autoReset = false;
    renderer.info.reset();
    stage.setFocus(camera.position.distanceTo(controls.target));
    stage.render();
    if (layers.labels) tags.render(tagScene, camera);
    lastRenderMs = performance.now() - t0;
    lastCalls = renderer.info.render.calls;
    lastTriangles = renderer.info.render.triangles;
    renders++;
    onRender?.(stats());
  }
  /** Coalesce bursts (camera drags, fast simulation updates) into one render per frame. */
  let pending = 0;
  function requestRender() {
    if (pending || disposed) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      render();
    });
  }

  function resize() {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    stage.setSize(w, h);
    tags.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    render();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  function build(desc: SceneDescription) {
    const group = new THREE.Group();
    group.add(stage.bench(desc, own));

    for (const c of desc.components) group.add(buildComponent(c, materials, own));

    // Wires (coloured by electrical node) and direct contacts: wires.ts.
    const wm = wireMaterials(own, materials.lead);
    // Their natural shape (sag, hand-formed bends), checked clear of every part and wire.
    const shapes = shapeWires(desc);
    currentShapes = shapes;
    for (const w of desc.wires) group.add(buildWire(w, own, wm, shapes.get(w.id)));
    // One twisted splice per junction (where the wires' stripped conductors meet).
    const splices = new Map<string, Vec3>();
    for (const w of desc.wires)
      for (const k of [0, 1] as const)
        if (w.ends[k] === 'junction') {
          const p = k === 0 ? w.points[0]! : w.points[w.points.length - 1]!;
          splices.set(`${p.x.toFixed(2)},${p.z.toFixed(2)}`, p);
        }
    for (const p of splices.values()) group.add(buildSplice(p, own, materials.lead));
    for (const j of desc.joints)
      group.add(buildJoint(j, own, { lead: materials.lead, notConnected: materials.red }));

    // LED glow halos (hidden until a running simulation lights the LED).
    halos = new Map();
    group.traverse((o) => {
      if (o.userData.lensMaterial && o.userData.component) {
        const halo = new THREE.Sprite(
          own.mat(
            new THREE.SpriteMaterial({
              map: haloTexture,
              color: o.userData.ledColor as string,
              transparent: true,
              opacity: 0,
              blending: THREE.AdditiveBlending,
              depthWrite: false,
            }),
          ),
        );
        halo.visible = false;
        halo.userData.halo = o.userData.component;
        const top = o.userData.ledTop as number;
        halo.position.set(0, top - 2, 0);
        halo.scale.set(11, 11, 1);
        o.add(halo);
        halos.set(o.userData.component as string, halo);
      }
    });

    batchStatic(group);
    return group;
  }

  /**
   * Static batching: the scene does not change between rebuilds, so every opaque mesh that
   * shares a material is merged into ONE draw (its transform baked in). On software WebGL each
   * draw is expensive and shadows draw every caster twice; this takes a circuit from hundreds of
   * draws to a few dozen. Meshes that must stay their own (an LED lens that glows, textured or
   * multi-material parts, instanced pins, sprites) are left alone.
   */
  function batchStatic(group: THREE.Group) {
    group.updateMatrixWorld(true);
    const inverse = group.matrixWorld.clone().invert();
    const buckets = new Map<THREE.Material, { geo: THREE.BufferGeometry; cast: boolean }[]>();
    const merged: THREE.Mesh[] = [];
    /** Meshes seen so far per part (a stable place for each mesh in its part). */
    const ordinal = new Map<string, number>();
    group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || (mesh as unknown as THREE.InstancedMesh).isInstancedMesh) return;
      // Actuators move (operated during a simulation): never merged into a static batch.
      if (o.name === 'base' || o.userData.noAo || o.userData.actuator || o.userData.layer) return;
      const mat = mesh.material;
      // A textured material batches only when its maps need nothing but per-vertex UVs
      // (`userData.batchUv`: the wire jackets, realism pass 6).
      if (Array.isArray(mat) || mat.transparent || (textured(mat) && !mat.userData.batchUv)) return;
      if (o.userData.lens || o.parent?.userData.lensMaterial === mat) return;
      let geo = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
      const keep = mat.userData.batchUv ? ['position', 'normal', 'uv'] : ['position', 'normal'];
      for (const name of Object.keys(geo.attributes))
        if (!keep.includes(name)) geo.deleteAttribute(name);
      // Full tier: each piece's deterministic finish offsets (variation.ts), seeded by its part
      // and its place in it.
      const family = quality === 'full' ? familyOf(mat) : null;
      if (family) {
        let owner: THREE.Object3D | null = mesh;
        while (owner && !owner.userData.component && owner.parent !== group) owner = owner.parent;
        const key = String(owner?.userData.component ?? owner?.name ?? '');
        const n = (ordinal.get(key) ?? 0) + 1;
        ordinal.set(key, n);
        geo.setAttribute(
          'aVar',
          variationAttribute(family, mesh.geometry, geo, `${key}/${mesh.name}/${n}`),
        );
      }
      geo.applyMatrix4(mesh.matrixWorld.clone().premultiply(inverse));
      geo = own.geo(geo);
      const list = buckets.get(mat) ?? [];
      list.push({ geo, cast: mesh.castShadow });
      buckets.set(mat, list);
      merged.push(mesh);
    });
    for (const m of merged) m.removeFromParent();
    for (const [mat, list] of buckets) {
      const geo = mergeGeometries(
        list.map((x) => x.geo),
        false,
      );
      if (!geo) continue;
      own.geo(geo);
      // A varied family draws with its one varied copy (made once per viewer).
      let drawn = mat;
      if (geo.attributes.aVar) {
        drawn = varied.get(mat) ?? variedMaterial(mat);
        varied.set(mat, drawn);
      }
      const batch = new THREE.Mesh(geo, drawn);
      batch.castShadow = list.some((x) => x.cast);
      batch.receiveShadow = true;
      batch.userData.batch = list.length;
      group.add(batch);
    }
  }

  /**
   * Frame the whole circuit, looking along `direction` (default: the standard view): the camera
   * distance is solved so the content's box fills FRAME_FILL of the view in its
   * tighter dimension, instead of wrapping a sphere around a flat, wide circuit.
   */
  function frame(desc: SceneDescription, direction?: THREE.Vector3) {
    const { min, max } = desc.bounds;
    const top = max.y;
    const maxZ = max.z;
    const center = new THREE.Vector3((min.x + max.x) / 2, top / 3, (min.z + maxZ) / 2);
    const radius = 0.5 * Math.max(20, Math.hypot(max.x - min.x, maxZ - min.z, top - min.y));
    const fov = (camera.fov * Math.PI) / 180;
    const fit = Math.max(
      radius / Math.sin(fov / 2),
      radius / Math.sin(Math.atan(Math.tan(fov / 2) * camera.aspect)),
    );
    // Default view: from the front (the 2D drawing's bottom edge), raised and a little to the right.
    // Realism pass: a 3/4 inspection angle about 30 degrees above the bench (was about 45),
    // so heights, pin rows and leads read while the layout still reads as the 2D drawing.
    const dir = (direction ?? new THREE.Vector3(0.55, 0.68, 1)).clone().normalize();
    // Frame what is actually there (realism pass 5: composed, not merely bounded): each part's
    // footprint at its own height and the wires' route points, instead of the bounding box's
    // corners (on a wide bench the box's top corners, at the tallest part's height over the
    // whole plan, left a band of empty mat and backdrop).
    const corners: THREE.Vector3[] = [];
    for (const c of desc.components) {
      const f = footprintRect(c);
      for (const x of [f.x0, f.x1])
        for (const z of [f.z0, f.z1])
          for (const y of [0, MODEL_HEIGHT[c.model]]) corners.push(new THREE.Vector3(x, y, z));
    }
    for (const w of desc.wires)
      for (const q of w.points) corners.push(new THREE.Vector3(q.x, q.y, q.z));
    if (!corners.length)
      for (const x of [min.x, max.x])
        for (const y of [min.y, top])
          for (const z of [min.z, maxZ]) corners.push(new THREE.Vector3(x, y, z));
    let distance = fit;
    const p = new THREE.Vector3();
    for (let i = 0; i < 6; i++) {
      camera.position.copy(center).addScaledVector(dir, distance);
      camera.lookAt(center);
      camera.updateMatrixWorld();
      let extent = 0;
      for (const c of corners) {
        p.copy(c).project(camera);
        extent = Math.max(extent, Math.abs(p.x), Math.abs(p.y));
      }
      if (!Number.isFinite(extent) || extent <= 0) break;
      // Perspective is not linear in distance; a few proportional steps converge.
      distance = Math.max(radius * 0.3, distance * (extent / FRAME_FILL));
    }
    const fitDistance = distance;
    camera.position.copy(center).addScaledVector(dir, fitDistance);
    camera.near = Math.max(0.1, fitDistance / 100);
    camera.far = fit * 20;
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.minDistance = radius * 0.15;
    controls.maxDistance = fit * 6;
    controls.update();
  }

  return {
    update(desc, opts = {}) {
      if (disposed) return;
      const first = current === null;
      if (content) {
        scene.remove(content);
        own.dispose();
        own = new OwnedResources(persistent, quality);
      }
      current = desc;
      for (const m of simplified.values()) m.dispose();
      simplified.clear();
      content = build(desc);
      if (quality === 'reduced') simplifyMaterials(content, simplified);
      stage.fit(desc);
      scene.add(content);
      lenses = new Map();
      buildTags(desc);
      applyLayers();
      matrices = new Map();
      lcds = new Map();
      content.traverse((o) => {
        const lens = o.userData.lensMaterial as THREE.MeshStandardMaterial | undefined;
        if (lens && o.userData.component)
          lenses.set(o.userData.component as string, {
            lens,
            die: o.userData.ledDie as THREE.MeshStandardMaterial | undefined,
            core: o.userData.ledCore as THREE.SpriteMaterial | undefined,
            coreObj: o.getObjectByProperty('isSprite', true)?.userData.ledCore
              ? o.getObjectByProperty('isSprite', true)
              : o.children.find((c) => c.userData.ledCore),
            gain: (o.userData.ledGain as number | undefined) ?? 2.2,
            at: o.localToWorld(new THREE.Vector3(0, (o.userData.ledTop as number) - 3.5, 0)),
            color: (o.userData.ledColor as string | undefined) ?? '#ffffff',
          });
        if (o.userData.matrixFace && o.userData.component)
          matrices.set(o.userData.component as string, o.userData.matrixFace);
        if (o.userData.lcdFace && o.userData.component)
          lcds.set(o.userData.component as string, o.userData.lcdFace);
      });
      applyLive();
      drawSelection();
      actuatorsById = new Map();
      tweens.clear();
      content.traverse((o) => {
        if (!o.userData.actuator) return;
        let p: THREE.Object3D | null = o;
        while (p && !p.userData.component) p = p.parent;
        if (p)
          actuatorsById.set(p.userData.component as string, {
            obj: o,
            kind: o.userData.actuator as string,
          });
      });
      applyControls(false);
      if (first || opts.resetCamera) {
        resize();
        frame(desc);
      }
      render();
    },
    setLive(levels) {
      if (disposed) return;
      liveLevels = levels;
      applyLive();
      requestRender();
    },
    resetCamera() {
      if (current) frame(current);
      render();
    },
    fit() {
      if (current) frame(current, camera.position.clone().sub(controls.target));
      render();
    },
    view(preset) {
      if (current) frame(current, new THREE.Vector3(...PRESETS[preset]));
      render();
    },
    rotate(radians) {
      const offset = camera.position.clone().sub(controls.target);
      offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), radians);
      camera.position.copy(controls.target.clone().add(offset));
      controls.update();
    },
    zoom(factor) {
      const offset = camera.position
        .clone()
        .sub(controls.target)
        .multiplyScalar(1 / factor);
      const len = THREE.MathUtils.clamp(
        offset.length(),
        controls.minDistance,
        controls.maxDistance,
      );
      camera.position.copy(controls.target.clone().add(offset.setLength(len)));
      controls.update();
    },
    pan(right, up) {
      // The visible height at the target's distance; move camera and target together along the
      // camera's own screen axes (what OrbitControls' screen-space pan does).
      const distance = camera.position.distanceTo(controls.target);
      const visible = 2 * distance * Math.tan((camera.fov * Math.PI) / 360);
      camera.updateMatrixWorld();
      const x = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
      const y = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
      const move = x.multiplyScalar(-right * visible).addScaledVector(y, -up * visible);
      camera.position.add(move);
      controls.target.add(move);
      controls.update();
    },
    inspect(target, from) {
      controls.target.set(...target);
      camera.position.set(...from);
      camera.near = Math.max(0.05, camera.position.distanceTo(controls.target) / 200);
      camera.updateProjectionMatrix();
      controls.update();
      render();
    },
    stats,
    rayAt(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
        -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
      );
      const rc = new THREE.Raycaster();
      camera.updateMatrixWorld();
      rc.setFromCamera(ndc, camera);
      return { origin: rc.ray.origin.toArray(), dir: rc.ray.direction.toArray() } as Ray;
    },
    screenOf(p) {
      camera.updateMatrixWorld();
      const v = new THREE.Vector3(...p).project(camera);
      const rect = canvas.getBoundingClientRect();
      return {
        x: rect.left + ((v.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - v.y) / 2) * rect.height,
      };
    },
    wireShapes: () => currentShapes,
    poses() {
      const out: Record<string, number> = {};
      for (const [id, a] of actuatorsById)
        out[id] = a.kind === 'toggle' ? a.obj.rotation.z : a.obj.position.y;
      return out;
    },
    setControls(state) {
      if (disposed) return;
      controls3d = { closed: { ...state.closed }, pressed: [...state.pressed] };
      applyControls(true);
    },
    setSelection(sel) {
      selected = { components: [...sel.components], wires: [...sel.wires] };
      drawSelection();
      requestRender();
    },
    setLayers(visible) {
      layers = { ...visible };
      applyLayers();
      requestRender();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (pending) cancelAnimationFrame(pending);
      if (animating) cancelAnimationFrame(animating);
      ro.disconnect();
      controls.dispose();
      if (content) scene.remove(content);
      selected = { components: [], wires: [] };
      drawSelection();
      clearTags();
      tags.domElement.remove();
      lenses = new Map();
      halos = new Map();
      own.dispose();
      persistent.dispose();
      for (const m of shared) m.dispose();
      haloTexture.dispose();
      for (const m of simplified.values()) m.dispose();
      for (const m of varied.values()) m.dispose();
      varied.clear();
      stage.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      live--;
    },
  };
}

/** Whether a material samples any texture (its mesh keeps its own texture coordinates). */
function textured(m: THREE.Material): boolean {
  const s = m as THREE.MeshPhysicalMaterial;
  return !!(
    s.map ||
    s.roughnessMap ||
    s.bumpMap ||
    s.normalMap ||
    s.alphaMap ||
    s.emissiveMap ||
    s.metalnessMap
  );
}

/** A soft radial glow (LED halo), drawn once per viewer. */
function glowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * `reduced` quality (software rasterisers): replace physical materials (clearcoat, sheen) by
 * standard ones of the same colour, map and finish, and damp metalness (no environment to
 * reflect: a fully metallic surface would read black). Same scene, same colours; only the
 * shading model is simpler. Each original maps to one stand-in, reused across rebuilds.
 */
function simplifyMaterials(root: THREE.Object3D, cache: Map<THREE.Material, THREE.Material>) {
  const swap = (m: THREE.Material): THREE.Material => {
    const p = m as THREE.MeshPhysicalMaterial;
    if (!p.isMeshPhysicalMaterial) {
      const s = m as THREE.MeshStandardMaterial;
      if (s.isMeshStandardMaterial && s.metalness > 0.6 && !cache.has(m)) {
        // Metals of the procedural models: damped the same way (and kept per original).
        const c = s.clone();
        c.metalness = 0.55;
        c.roughness = Math.max(c.roughness, 0.3);
        cache.set(m, c);
      }
      return cache.get(m) ?? m;
    }
    let out = cache.get(m);
    if (!out) {
      out = new THREE.MeshStandardMaterial({
        name: p.name,
        color: p.color,
        map: p.map,
        roughness: p.roughness,
        metalness: Math.min(p.metalness, 0.55),
        transparent: p.transparent,
        opacity: p.opacity,
        emissive: p.emissive,
        emissiveIntensity: p.emissiveIntensity,
        emissiveMap: p.emissiveMap,
        alphaTest: p.alphaTest,
        side: p.side,
        polygonOffset: p.polygonOffset,
        polygonOffsetFactor: p.polygonOffsetFactor,
        polygonOffsetUnits: p.polygonOffsetUnits,
        depthWrite: p.depthWrite,
      });
      out.userData = p.userData;
      cache.set(m, out);
    }
    return out;
  };
  root.traverse((o) => {
    // An LED's live glow drives its lens material: point it at the stand-in that is drawn.
    const lens = o.userData.lensMaterial as THREE.Material | undefined;
    if (lens) o.userData.lensMaterial = swap(lens);
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
  });
}

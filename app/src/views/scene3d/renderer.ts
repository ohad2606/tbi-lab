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
import { buildComponent, createMaterials, OwnedResources, paintMatrixFace } from './models.js';
import { assetLoadStats, loadAssets } from './assets/library.js';
import { createStage } from './stage.js';
import { buildJoint, buildWire, wireMaterials } from './wires.js';

export { assetLoadStats, loadAssets };
import { MODEL_HEIGHT, type SceneDescription } from './scene.js';

/** LED light pool size and the light's intensity per unit live level (mm scene, decay 2). */
const LED_LIGHTS = 4;
const LED_LIGHT = 90;
/** Reference labels: world height in mm (perspective), capped on screen so near ones never loom. */
const LABEL_WORLD_HEIGHT = 2.4;
/** Labels float this far (mm) above their part's tallest point. */
const LABEL_LIFT = 2.6;
const LABEL_MAX_PX = 26;
/** Fit/reset: the content's projected box spans this fraction of the view (NDC half-extent). */
const FRAME_FILL = 0.95;

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
  stats(): ViewerStats;
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
  | { dots: number[] };
const QUALITY_KEY = 'tbi-lab.3d.quality';
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render/i;

/**
 * The quality tier for a WebGL renderer name (UNMASKED_RENDERER_WEBGL) and an optional per-browser
 * override: software rasterisers get `reduced`, every real GPU `full`. Capability-based (the
 * renderer string), never by browser brand.
 */
export function chooseQuality(renderer: string, override: string | null): RenderQuality {
  if (override === 'full' || override === 'reduced') return override;
  return SOFTWARE_RENDERER.test(renderer) ? 'reduced' : 'full';
}

/** Whether WebGL works here, and which quality this device should get. */
function probeWebgl(): RenderQuality | null {
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return null;
    let override: string | null = null;
    try {
      override = localStorage.getItem(QUALITY_KEY);
    } catch {
      /* storage unavailable: no override */
    }
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(
      info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    );
    // Release the probe's context in every case (browsers cap live WebGL contexts).
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return chooseQuality(name, override);
  } catch {
    return null;
  }
}

export function createViewer(container: HTMLElement, onRender?: (s: ViewerStats) => void): Viewer {
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

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 2000);
  // Lights, environment, shadows, ambient occlusion, bench and backdrop: the stage (stage.ts).
  const stage = createStage(renderer, scene, camera, quality);
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
  let labels: THREE.Sprite[] = [];
  const toCamera = new THREE.Vector3();
  /** Cap each label's on-screen height (cheap: one distance per label, only when rendering). */
  function sizeLabels() {
    const pxPerUnitAt1 = container.clientHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
    for (const l of labels) {
      const d = toCamera
        .copy(l.position)
        .applyMatrix4(l.parent!.matrixWorld)
        .distanceTo(camera.position);
      const px = (LABEL_WORLD_HEIGHT * pxPerUnitAt1) / Math.max(d, 1e-3);
      const h = LABEL_WORLD_HEIGHT * Math.min(1, LABEL_MAX_PX / px);
      l.scale.set((h * 4.8) / 1.8, h, 1);
    }
  }
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
    // The light pool (full tier): the brightest lit LEDs light their surroundings.
    const lit: { level: number; at: THREE.Vector3; color: string }[] = [];
    for (const [id, { lens: mat, die, gain, at, color }] of lenses) {
      const raw = liveLevels[id] ?? 0;
      if (typeof raw === 'object' && 'dots' in raw) continue;
      const live = raw;
      const level = typeof live === 'number' ? live : live.level;
      // The die is the light source; the epoxy glows with the light it scatters (diffused lenses
      // more than clear ones). A coloured live mix (RGB) on a water-clear lens: weaker emission
      // so the hue reads, not white.
      mat.emissiveIntensity = level * (typeof live === 'number' ? gain : 0.9);
      if (die) die.emissiveIntensity = level * 6;
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
      target: controls.target.toArray().map((v) => Math.round(v * 100) / 100) as [
        number,
        number,
        number,
      ],
    };
  };

  function render() {
    if (disposed) return;
    sizeLabels();
    const t0 = performance.now();
    // Count every pass of the frame (shadow, AO, beauty, output), not only the last one.
    renderer.info.autoReset = false;
    renderer.info.reset();
    stage.render();
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
    for (const w of desc.wires) group.add(buildWire(w, own, wm));
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
    for (const c of desc.components) group.add(label(c.id, c.x, c.z, desc));
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
    group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || (mesh as unknown as THREE.InstancedMesh).isInstancedMesh) return;
      if (o.name === 'base') return;
      const mat = mesh.material;
      if (Array.isArray(mat) || mat.transparent || textured(mat)) return;
      if (o.userData.lens || o.parent?.userData.lensMaterial === mat) return;
      let geo = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
      for (const name of Object.keys(geo.attributes))
        if (name !== 'position' && name !== 'normal') geo.deleteAttribute(name);
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
      const batch = new THREE.Mesh(geo, mat);
      batch.castShadow = list.some((x) => x.cast);
      batch.receiveShadow = true;
      batch.userData.batch = list.length;
      group.add(batch);
    }
  }

  /**
   * A reference designator (R1, U1) floating above its part, always facing the camera, LTR. It
   * keeps perspective (far labels small, so large circuits do not drown in labels) but never
   * grows beyond LABEL_MAX_PX on screen (sizeLabels).
   */
  function label(text: string, x: number, z: number, desc: SceneDescription) {
    const canvas2d = document.createElement('canvas');
    canvas2d.width = 256;
    canvas2d.height = 96;
    const ctx = canvas2d.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.strokeStyle = 'rgba(20,24,31,0.35)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(28, 14, 200, 68, 14);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#14181f';
    ctx.font = 'bold 52px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.direction = 'ltr';
    ctx.fillText(text, 128, 50);
    const tex = new THREE.CanvasTexture(canvas2d);
    tex.colorSpace = THREE.SRGBColorSpace;
    own.textures.push(tex);
    const sprite = new THREE.Sprite(
      own.mat(new THREE.SpriteMaterial({ map: tex, depthTest: false })),
    );
    const c = desc.components.find((k) => k.id === text);
    const height = (c ? MODEL_HEIGHT[c.model] : 3) + LABEL_LIFT;
    sprite.position.set(x, height, z);
    sprite.scale.set((LABEL_WORLD_HEIGHT * 4.8) / 1.8, LABEL_WORLD_HEIGHT, 1);
    sprite.userData.label = true;
    sprite.renderOrder = 10;
    sprite.name = `label:${text}`;
    return sprite;
  }

  /**
   * Frame the whole circuit, looking along `direction` (default: the standard view): the camera
   * distance is solved so the content's box (labels included) fills FRAME_FILL of the view in its
   * tighter dimension, instead of wrapping a sphere around a flat, wide circuit.
   */
  function frame(desc: SceneDescription, direction?: THREE.Vector3) {
    const { min, max } = desc.bounds;
    const top = max.y + LABEL_LIFT + LABEL_WORLD_HEIGHT / 2; // the reference labels above parts
    const center = new THREE.Vector3((min.x + max.x) / 2, top / 3, (min.z + max.z) / 2);
    const radius = 0.5 * Math.max(20, Math.hypot(max.x - min.x, max.z - min.z, top - min.y));
    const fov = (camera.fov * Math.PI) / 180;
    const fit = Math.max(
      radius / Math.sin(fov / 2),
      radius / Math.sin(Math.atan(Math.tan(fov / 2) * camera.aspect)),
    );
    // Default view: from the front (the 2D drawing's bottom edge), raised and a little to the right.
    // Realism pass: a 3/4 inspection angle about 30 degrees above the bench (was about 45),
    // so heights, pin rows and leads read while the layout still reads as the 2D drawing.
    const dir = (direction ?? new THREE.Vector3(0.55, 0.68, 1)).clone().normalize();
    const corners: THREE.Vector3[] = [];
    for (const x of [min.x, max.x])
      for (const y of [min.y, top])
        for (const z of [min.z, max.z]) corners.push(new THREE.Vector3(x, y, z));
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
      labels = [];
      content.traverse((o) => {
        if (o.userData.label) labels.push(o as THREE.Sprite);
      });
      matrices = new Map();
      content.traverse((o) => {
        const lens = o.userData.lensMaterial as THREE.MeshStandardMaterial | undefined;
        if (lens && o.userData.component)
          lenses.set(o.userData.component as string, {
            lens,
            die: o.userData.ledDie as THREE.MeshStandardMaterial | undefined,
            gain: (o.userData.ledGain as number | undefined) ?? 2.2,
            at: o.localToWorld(new THREE.Vector3(0, (o.userData.ledTop as number) - 3.5, 0)),
            color: (o.userData.ledColor as string | undefined) ?? '#ffffff',
          });
        if (o.userData.matrixFace && o.userData.component)
          matrices.set(o.userData.component as string, o.userData.matrixFace);
      });
      applyLive();
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
    dispose() {
      if (disposed) return;
      disposed = true;
      if (pending) cancelAnimationFrame(pending);
      ro.disconnect();
      controls.dispose();
      if (content) scene.remove(content);
      labels = [];
      lenses = new Map();
      halos = new Map();
      own.dispose();
      persistent.dispose();
      for (const m of shared) m.dispose();
      haloTexture.dispose();
      for (const m of simplified.values()) m.dispose();
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

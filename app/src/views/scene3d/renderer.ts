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
import { buildComponent, createMaterials, OwnedResources, roundPath } from './models.js';
import { WIRE } from './physical.js';
import { MODEL_HEIGHT, WIRE_RADIUS, type SceneDescription } from './scene.js';

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
  /** The camera's orbit target (what pan moves), rounded to 0.01 scene units. */
  target: [number, number, number];
}

export interface Viewer {
  update(scene: SceneDescription, opts?: { resetCamera?: boolean }): void;
  /**
   * Live presentation state while a simulation runs: LED glow level 0..1 per component id (the
   * same visual cue as the circuit view: full at 20 mA). Never an electrical input.
   */
  setLive(levels: Record<string, number>): void;
  resetCamera(): void;
  /** Frame the whole circuit from the current viewing direction. */
  fit(): void;
  rotate(radians: number): void;
  zoom(factor: number): void;
  /**
   * Move the view (camera and target together) by a fraction of the visible height, right and
   * up on screen: the same motion as a right- or middle-button drag.
   */
  pan(right: number, up: number): void;
  stats(): ViewerStats;
  dispose(): void;
}

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
const QUALITY_KEY = 'tbi-lab.3d.quality';
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render/i;

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
    if (override === 'full' || override === 'reduced') return override;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(
      info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    );
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return SOFTWARE_RENDERER.test(name) ? 'reduced' : 'full';
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
      antialias: quality === 'full',
      powerPreference: 'low-power',
    });
  } catch (e) {
    throw new WebGLUnavailableError((e as Error).message);
  }
  live++;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Neutral tone mapping keeps part colours (LED lenses, colour bands, wire colours) true.
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = quality === 'full';
  // The key light is fixed in the world, so shadows depend only on the scene, not on the camera:
  // the shadow map is rendered when the scene is (re)built, not on every orbit/pan frame.
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setClearColor('#e9edf2');
  const canvas = renderer.domElement;
  canvas.classList.add('view3d-canvas');
  canvas.setAttribute('aria-hidden', 'true');
  container.appendChild(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 2000);
  // A clean workbench: a bright sky/bench hemisphere, one shadow-casting key light from the front
  // right, a cool fill and a low rim light that puts highlights on metal (pins, leads, the module
  // can). No image-based environment: prefiltering one (PMREM) costs seconds per opening on
  // software WebGL, and every viewer has its own WebGL context, so it could not be shared.
  scene.add(new THREE.HemisphereLight('#ffffff', '#a3aab1', 1.35));
  const sun = new THREE.DirectionalLight('#fff8ef', 2.1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 3;
  scene.add(sun, sun.target);
  const fill = new THREE.DirectionalLight('#e8f0ff', 0.55);
  fill.position.set(-60, 50, -40);
  const rim = new THREE.DirectionalLight('#ffffff', 0.6);
  rim.position.set(-20, 15, 80);
  scene.add(fill, rim);
  /** Aim the key light and fit its shadow camera to the content (mm). */
  function fitShadow(desc: SceneDescription) {
    const { min, max } = desc.bounds;
    const cx = (min.x + max.x) / 2;
    const cz = (min.z + max.z) / 2;
    const r = 0.5 * Math.hypot(max.x - min.x, max.z - min.z, max.y) + 10;
    sun.target.position.set(cx, 0, cz);
    sun.position.set(cx + r * 0.55, r * 1.4, cz + r * 0.8);
    const cam = sun.shadow.camera;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = 1;
    cam.far = r * 4;
    cam.updateProjectionMatrix();
  }

  const materials = createMaterials();
  const shared: THREE.Material[] = Object.values(materials);
  const baseMat = new THREE.MeshStandardMaterial({ color: '#dfe5ea', roughness: 0.95 });
  const soldermat = new THREE.MeshStandardMaterial({
    color: '#cfd4d9',
    metalness: 0.9,
    roughness: 0.25,
  });
  const haloTexture = glowTexture();
  shared.push(baseMat, soldermat);

  let content: THREE.Group | null = null;
  let own = new OwnedResources();
  let current: SceneDescription | null = null;
  let renders = 0;
  /** LED lens materials by component id, and the last live levels applied to them. */
  let lenses = new Map<string, THREE.MeshStandardMaterial>();
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
  let liveLevels: Record<string, number> = {};
  /** Glow halos of the LEDs, by component id. */
  let halos = new Map<string, THREE.Sprite>();
  function applyLive() {
    for (const [id, mat] of lenses) {
      const level = liveLevels[id] ?? 0;
      mat.emissiveIntensity = level * 2.2;
      const halo = halos.get(id);
      if (halo) {
        halo.visible = level > 0;
        (halo.material as THREE.SpriteMaterial).opacity = 0.75 * level;
      }
    }
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
    return {
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      objects,
      renders,
      quality,
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
    renderer.render(scene, camera);
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
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    render();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  function build(desc: SceneDescription) {
    const group = new THREE.Group();
    const b = desc.base;
    const base = new THREE.Mesh(
      own.geo(new THREE.BoxGeometry(b.maxX - b.minX, 0.2, b.maxZ - b.minZ)),
      baseMat,
    );
    base.position.set((b.minX + b.maxX) / 2, -0.1, (b.minZ + b.maxZ) / 2);
    base.name = 'base';
    base.receiveShadow = true;
    group.add(base);
    // A faint grid on the bench every 5 editor grid steps (12.7 mm = 0.5 in).
    const step = 12.7;
    const lines: number[] = [];
    for (let x = Math.ceil(b.minX / step) * step; x <= b.maxX; x += step)
      lines.push(x, 0.01, b.minZ, x, 0.01, b.maxZ);
    for (let z = Math.ceil(b.minZ / step) * step; z <= b.maxZ; z += step)
      lines.push(b.minX, 0.01, z, b.maxX, 0.01, z);
    const gridGeo = own.geo(new THREE.BufferGeometry());
    gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    const grid = new THREE.LineSegments(
      gridGeo,
      own.mat(new THREE.LineBasicMaterial({ color: '#cdd4db' })),
    );
    grid.name = 'grid';
    group.add(grid);

    for (const c of desc.components) group.add(buildComponent(c, materials, own));

    // Wires: insulated round wire with smooth bends, coloured by electrical node.
    const wireMats = new Map<string, THREE.Material>();
    for (const w of desc.wires) {
      let mat = wireMats.get(w.color);
      if (!mat) {
        mat = own.mat(new THREE.MeshStandardMaterial({ color: w.color, roughness: 0.48 }));
        wireMats.set(w.color, mat);
      }
      const wire = new THREE.Group();
      wire.name = `wire:${w.id}`;
      wire.userData.node = w.node;
      const path = roundPath(
        w.points.map((p) => [p.x, p.y, p.z] as [number, number, number]),
        WIRE.bendRadiusMm,
      );
      const tube = new THREE.Mesh(
        own.geo(
          new THREE.TubeGeometry(
            path,
            Math.max(12, Math.ceil(path.getLength() / 0.8)),
            WIRE_RADIUS,
            10,
          ),
        ),
        mat,
      );
      tube.castShadow = true;
      wire.add(tube);
      // Rounded wire ends.
      for (const q of [w.points[0]!, w.points[w.points.length - 1]!]) {
        const end = new THREE.Mesh(
          own.shared('wireEnd', () => new THREE.SphereGeometry(WIRE_RADIUS, 12, 8)),
          mat,
        );
        end.position.set(q.x, q.y, q.z);
        wire.add(end);
      }
      group.add(wire);
    }

    // Where terminals meet: a solder joint only where the project connects them; touching but
    // unconnected terminals get a red not-connected ring over the gap their leads leave.
    for (const j of desc.joints) {
      const mark =
        j.kind === 'contact'
          ? new THREE.Mesh(
              own.shared('solder', () => new THREE.SphereGeometry(0.75, 16, 12)),
              soldermat,
            )
          : new THREE.Mesh(
              own.shared('open', () => new THREE.TorusGeometry(1.5, 0.2, 8, 32)),
              materials.red,
            );
      if (j.kind === 'open') mark.rotation.x = Math.PI / 2;
      mark.position.set(j.x, j.y, j.z);
      mark.name = `joint:${j.kind}:${j.terminals.join('+')}`;
      mark.userData.joint = j.kind;
      group.add(mark);
      // A lead soldered to a pin a step away: bridge them.
      for (const l of j.links ?? []) {
        const link = new THREE.Mesh(
          own.geo(
            new THREE.TubeGeometry(
              roundPath(
                [
                  [j.x, j.y, j.z],
                  [l.x, j.y, l.z],
                  [l.x, l.y, l.z],
                ],
                0.5,
              ),
              12,
              0.3,
              8,
            ),
          ),
          soldermat,
        );
        group.add(link);
      }
    }

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
        halo.scale.set(16, 16, 1);
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
      if (Array.isArray(mat) || mat.transparent || (mat as THREE.MeshStandardMaterial).map) return;
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
    const dir = (direction ?? new THREE.Vector3(0.35, 0.85, 1)).clone().normalize();
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
        own = new OwnedResources();
      }
      current = desc;
      content = build(desc);
      fitShadow(desc);
      renderer.shadowMap.needsUpdate = true;
      scene.add(content);
      lenses = new Map();
      labels = [];
      content.traverse((o) => {
        if (o.userData.label) labels.push(o as THREE.Sprite);
      });
      content.traverse((o) => {
        const lens = o.userData.lensMaterial as THREE.MeshStandardMaterial | undefined;
        if (lens && o.userData.component) lenses.set(o.userData.component as string, lens);
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
      for (const m of shared) m.dispose();
      haloTexture.dispose();
      sun.shadow.map?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      live--;
    },
  };
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

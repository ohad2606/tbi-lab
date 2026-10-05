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
import { buildComponent, createMaterials, OwnedResources, segment } from './models.js';
import { MODEL_HEIGHT, WIRE_RADIUS, type SceneDescription } from './scene.js';

/** Reference labels: world height (perspective), capped on screen so near ones never loom. */
const LABEL_WORLD_HEIGHT = 1.8;
const LABEL_MAX_PX = 26;
/** Fit/reset: the content's projected box spans this fraction of the view (NDC half-extent). */
const FRAME_FILL = 0.95;

export interface ViewerStats {
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

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch {
    return false;
  }
}

export function createViewer(container: HTMLElement, onRender?: (s: ViewerStats) => void): Viewer {
  if (!webglAvailable()) throw new WebGLUnavailableError('WebGL is not available');
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'low-power' });
  } catch (e) {
    throw new WebGLUnavailableError((e as Error).message);
  }
  live++;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor('#eef1f5');
  const canvas = renderer.domElement;
  canvas.classList.add('view3d-canvas');
  canvas.setAttribute('aria-hidden', 'true');
  container.appendChild(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 2000);
  scene.add(new THREE.HemisphereLight('#ffffff', '#8a8f96', 1.6));
  const sun = new THREE.DirectionalLight('#ffffff', 1.6);
  sun.position.set(30, 60, 40);
  scene.add(sun);
  const fill = new THREE.DirectionalLight('#ffffff', 0.5);
  fill.position.set(-40, 30, -30);
  scene.add(fill);

  const materials = createMaterials();
  const shared: THREE.Material[] = Object.values(materials);
  const baseMat = new THREE.MeshStandardMaterial({ color: '#f7f8fa', roughness: 0.9 });
  shared.push(baseMat);

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
  function applyLive() {
    for (const [id, mat] of lenses) {
      const level = liveLevels[id] ?? 0;
      mat.emissive.copy(mat.color);
      mat.emissiveIntensity = level * 1.6;
      mat.opacity = 0.85 + 0.15 * level;
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
    group.add(base);
    // A light grid on the base at the circuit editor's grid pitch (20 units = 2 scene units).
    const lines: number[] = [];
    for (let x = Math.ceil(b.minX / 2) * 2; x <= b.maxX; x += 2)
      lines.push(x, 0.01, b.minZ, x, 0.01, b.maxZ);
    for (let z = Math.ceil(b.minZ / 2) * 2; z <= b.maxZ; z += 2)
      lines.push(b.minX, 0.01, z, b.maxX, 0.01, z);
    const gridGeo = own.geo(new THREE.BufferGeometry());
    gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    const grid = new THREE.LineSegments(
      gridGeo,
      own.mat(new THREE.LineBasicMaterial({ color: '#dfe4ea' })),
    );
    grid.name = 'grid';
    group.add(grid);

    for (const c of desc.components) group.add(buildComponent(c, materials, own));

    const wireMats = new Map<string, THREE.Material>();
    for (const w of desc.wires) {
      let mat = wireMats.get(w.color);
      if (!mat) {
        mat = own.mat(new THREE.MeshStandardMaterial({ color: w.color, roughness: 0.55 }));
        wireMats.set(w.color, mat);
      }
      const wire = new THREE.Group();
      wire.name = `wire:${w.id}`;
      wire.userData.node = w.node;
      for (let i = 1; i < w.points.length; i++) {
        const p0 = w.points[i - 1]!;
        const p1 = w.points[i]!;
        const seg = segment(
          own,
          new THREE.Vector3(p0.x, p0.y, p0.z),
          new THREE.Vector3(p1.x, p1.y, p1.z),
          WIRE_RADIUS,
          mat,
          10,
        );
        if (seg) wire.add(seg);
      }
      // Rounded joints so bends read as one continuous wire.
      for (const q of w.points) {
        const joint = new THREE.Mesh(
          own.shared('joint', () => new THREE.SphereGeometry(WIRE_RADIUS, 10, 8)),
          mat,
        );
        joint.position.set(q.x, q.y, q.z);
        wire.add(joint);
      }
      group.add(wire);
    }

    // Where terminals meet: a solder joint only where the project connects them; touching but
    // unconnected terminals get a red not-connected ring over the gap their leads leave.
    for (const j of desc.joints) {
      const mark =
        j.kind === 'contact'
          ? new THREE.Mesh(
              own.shared('solder', () => new THREE.SphereGeometry(0.3, 16, 12)),
              materials.silver,
            )
          : new THREE.Mesh(
              own.shared('open', () => new THREE.TorusGeometry(0.55, 0.07, 8, 28)),
              materials.red,
            );
      if (j.kind === 'open') mark.rotation.x = Math.PI / 2;
      mark.position.set(j.x, j.y, j.z);
      mark.name = `joint:${j.kind}:${j.terminals.join('+')}`;
      mark.userData.joint = j.kind;
      group.add(mark);
    }

    for (const c of desc.components) group.add(label(c.id, c.x, c.z, desc));
    return group;
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
    const ctx = canvas2d.getContext('2d')!;
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
    const height = (c ? MODEL_HEIGHT[c.model] : 1.5) + 1.6;
    sprite.position.set(x, height, z);
    sprite.scale.set(4.8, LABEL_WORLD_HEIGHT, 1);
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
    const top = max.y + 1.6; // the reference labels sit 1.6 above their part
    const center = new THREE.Vector3((min.x + max.x) / 2, top / 3, (min.z + max.z) / 2);
    const radius = 0.5 * Math.max(8, Math.hypot(max.x - min.x, max.z - min.z, top - min.y));
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
      own.dispose();
      for (const m of shared) m.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      live--;
    },
  };
}

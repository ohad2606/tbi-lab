/**
 * The 3D view's stage (Sprint 10 realism pass): the electronics-bench photo set around the circuit.
 * Lighting, environment reflections, shadows, ambient occlusion, the bench surface and the frame's
 * post-processing live here; the parts and wires (models.ts, renderer.ts) know nothing of them.
 *
 * Two tiers (RenderQuality, renderer.ts), the scene itself identical in both:
 * - `full` (any real GPU): a studio environment for reflections (three.js RoomEnvironment,
 *   procedural, bundled: no image file), a soft key light whose shadow covers the circuit, ground-
 *   truth ambient occlusion (GTAO) for contact shading where parts meet the bench and each other,
 *   4x multisampling, physically based materials.
 * - `reduced` (software rasterisers): hemisphere + key light, no shadows, no AO, no environment,
 *   standard materials. Every extra pass there costs about a second per frame on the CPU.
 *
 * Bench (realism pass 4): a finite ESD work mat under the circuit (muted blue-grey, matte, a fine
 * grain, 2 mm thick with a soft rounded edge, a faint printed 0.5 in grid and a millimetre scale
 * along its front edge) lying on a neutral desk that fades into the background (no horizon line),
 * and a soft gradient backdrop. No breadboard: a breadboard is a real construction method, shown
 * only when a project has one. Contact shadows: a soft darkening under every part where it meets
 * the mat (one merged mesh, both tiers), so nothing floats even without shadow maps.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { rotatePoint } from '@tbi-lab/domain';
import type { OwnedResources } from './kit.js';
import { FOOTPRINT, type ModelKey, type SceneDescription } from './scene.js';

export type Tier = 'full' | 'reduced';

/**
 * Desk, mat and backdrop colours (sRGB). The mat a muted blue-grey (the common dissipative work
 * mat), light enough that black wires and the ESP32's black PCB keep their edges; the desk a light
 * warm neutral; the grid printed a little lighter than the mat.
 */
const DESK = '#c3c3c0';
/** The reduced tier's clear colour: the desk as the lit plane shows it there. */
const DESK_REDUCED = '#b9b9b6';
const MAT = '#7b8d97';
const MAT_EDGE = '#6a7b85';
const BACKDROP_TOP = '#f1f3f5';
const BACKDROP_BOTTOM = '#cfd3d8';
const GRID = '#a9b8c0';
/** Mat thickness (its top is the bench plane, y = 0), corner radius, margin round the circuit. */
export const MAT_T = 2;
const MAT_CORNER = 8;
/** Bench grid pitch: five editor grid steps, 0.5 in. */
const GRID_STEP_MM = 12.7;

export interface Stage {
  /** Draw one frame. */
  render(): void;
  setSize(width: number, height: number): void;
  /** Aim the key light and fit its shadow to the circuit; called on every rebuild. */
  fit(desc: SceneDescription): void;
  /** The bench surface and grid for a circuit (owned by the build). */
  bench(desc: SceneDescription, own: OwnedResources): THREE.Object3D;
  /** Device pixel ratio actually used. */
  readonly pixelRatio: number;
  dispose(): void;
}

/**
 * Pixel ratio: full tier up to 2 (sharper silkscreen and leads on high-density screens; 3x/4x
 * would cost 2.25-4x the fragments for little visible gain), reduced tier 1 (software rendering
 * cost is per pixel).
 */
export function stagePixelRatio(tier: Tier, devicePixelRatio: number): number {
  return tier === 'full' ? Math.min(Math.max(devicePixelRatio || 1, 1), 2) : 1;
}

export function createStage(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  tier: Tier,
): Stage {
  const full = tier === 'full';
  const pixelRatio = stagePixelRatio(tier, window.devicePixelRatio);
  renderer.setPixelRatio(pixelRatio);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Khronos PBR Neutral: product-shot tone mapping that keeps base colours (LED lenses, colour
  // bands, wire insulation) true while rolling off highlights on metal.
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = full;
  // The lights are fixed in the world: the shadow map depends only on the scene, so it is drawn
  // when the scene is (re)built, never on an orbit or pan frame.
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  // Backdrop: a soft vertical gradient (lighter above), a 2 x 64 texture.
  // Reduced tier: a plain clear colour (a background texture is one more full-screen draw, and
  // fill rate is what a software rasteriser pays for).
  const backdrop = full ? gradientTexture(BACKDROP_TOP, BACKDROP_BOTTOM) : null;
  scene.background = backdrop;
  renderer.setClearColor(full ? BACKDROP_BOTTOM : DESK_REDUCED);

  // Lights: clean product photography (realism pass 4). A large, neutral key high from the back
  // left (seen from the default camera its soft shadows fall forward, where they read as contact
  // with the mat), a large neutral fill from the front right that keeps black plastics and the
  // PCB's mask readable, a gentle rim for separation and highlights on metal; full: the studio
  // environment does most of the remaining fill. No coloured or high-contrast lighting.
  const hemi = new THREE.HemisphereLight('#ffffff', '#9aa1a8', full ? 0.12 : 1.35);
  const key = new THREE.DirectionalLight('#fffaf3', full ? 2.5 : 2.1);
  key.castShadow = full;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.02;
  // A large source: soft-edged shadows.
  key.shadow.radius = 4;
  key.shadow.blurSamples = 20;
  const fill = new THREE.DirectionalLight('#f3f6ff', full ? 0.6 : 0.6);
  const rim = new THREE.DirectionalLight('#ffffff', full ? 0.45 : 0.6);
  rim.position.set(-20, 15, 80);
  scene.add(hemi, key, key.target, fill, rim);

  // Studio reflections (high-fidelity pass 3): a product-shot studio built in code (no image
  // asset, project-owned): a soft sky over a darker floor, a large overhead softbox, two tall
  // strip lights and a low front card. Metal (leads, the USB shell, the RF can, pins) shows
  // bright soft highlights and readable form instead of a dull grey; prefiltered once per viewer.
  let env: THREE.Texture | null = null;
  if (full) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const studio = studioScene();
    env = pmrem.fromScene(studio, 0.03).texture;
    studio.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });
    pmrem.dispose();
  }
  scene.environment = env;
  scene.environmentIntensity = full ? STUDIO_INTENSITY : 0.4;

  // Full: multisampled HDR frame -> GTAO (contact shading) -> tone mapping and sRGB output.
  let composer: EffectComposer | null = null;
  let gtao: GTAOPass | null = null;
  if (full) {
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    composer = new EffectComposer(renderer, target);
    composer.setPixelRatio(pixelRatio);
    composer.addPass(new RenderPass(scene, camera));
    gtao = new GTAOPass(scene, camera, 1, 1);
    gtao.blendIntensity = 1;
    // World units are mm: a 5 mm reach shades where leads, pins and bodies meet the board/bench.
    gtao.updateGtaoMaterial({
      radius: 5,
      distanceExponent: 1,
      thickness: 3,
      scale: 2,
      samples: 16,
    });
    gtao.updatePdMaterial({
      lumaPhi: 10,
      depthPhi: 2,
      normalPhi: 3,
      radius: 6,
      rings: 2,
      samples: 16,
    });
    excludeTransparentFromAo(gtao);
    composer.addPass(gtao);
    composer.addPass(new OutputPass());
  }

  /** A fine, non-repeating-looking matte grain (bump and roughness) for desk and mat. */
  let grain: THREE.Texture | null = null;
  let matGrain: THREE.Texture | null = null;
  // Full tier: the desk fades out towards its rim (alpha), so no horizon line shows. Reduced
  // tier: opaque (a blended full-screen plane is costly on a software rasteriser), its size
  // limited to the circuit's surroundings.
  const benchMat = new THREE.MeshStandardMaterial({
    color: DESK,
    roughness: 0.9,
    metalness: 0,
    transparent: full,
    alphaMap: full ? radialFade() : null,
    depthWrite: true,
  });
  const matMat = new THREE.MeshStandardMaterial({ color: MAT, roughness: 0.86, metalness: 0 });
  const matEdgeMat = new THREE.MeshStandardMaterial({
    color: MAT_EDGE,
    roughness: 0.9,
    metalness: 0,
  });
  if (full) {
    // A desk lit from above is a little brighter under the lamp than at its rim (soft falloff).
    benchMat.map = falloffTexture();
    grain = grainTexture();
    benchMat.bumpMap = grain;
    benchMat.bumpScale = 0.4;
    benchMat.roughnessMap = grain;
    // The mat: the same grain, finer (its UVs are in mm: about 6 texels per mm).
    matGrain = grain.clone();
    matGrain.repeat.set(1 / 42, 1 / 42);
    matMat.bumpMap = matGrain;
    matMat.bumpScale = 0.25;
    matMat.roughnessMap = matGrain;
  }
  const gridMat = new THREE.LineBasicMaterial({ color: GRID, transparent: true, opacity: 0.32 });
  // Contact shadows: the same material kind as the bench labels (a transparent map on a standard
  // material), so no extra shader program is compiled for them: that costs about a second on a
  // software rasteriser. The texture is black; its alpha carries the softness and the strength.
  const contactMat = new THREE.MeshStandardMaterial({
    map: contactTexture(),
    transparent: true,
    depthWrite: false,
    roughness: 0.9,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  return {
    pixelRatio,
    render() {
      if (composer) composer.render();
      else renderer.render(scene, camera);
    },
    setSize(width, height) {
      composer?.setSize(width, height);
    },
    fit(desc) {
      const { min, max } = desc.bounds;
      const cx = (min.x + max.x) / 2;
      const cz = (min.z + max.z) / 2;
      const r = 0.5 * Math.hypot(max.x - min.x, max.z - min.z, max.y) + 8;
      key.target.position.set(cx, 0, cz);
      key.position.set(cx - r * 0.6, r * 1.4, cz - r * 0.45);
      fill.position.set(cx + r * 0.8, r * 0.65, cz + r);
      const cam = key.shadow.camera;
      cam.left = -r;
      cam.right = r;
      cam.top = r;
      cam.bottom = -r;
      cam.near = 1;
      cam.far = r * 4;
      cam.updateProjectionMatrix();
      renderer.shadowMap.needsUpdate = true;
    },
    bench(desc, own) {
      const g = new THREE.Group();
      g.name = 'bench';
      const b = desc.base;
      const cx = (b.minX + b.maxX) / 2;
      const cz = (b.minZ + b.maxZ) / 2;
      const extent = Math.max(b.maxX - b.minX, b.maxZ - b.minZ, 80);
      // The desk: large enough that its faded rim lies well outside any view of the circuit. The
      // reduced tier draws none: the frame is cleared to the desk's colour (a lit full-screen
      // plane is what a software rasteriser pays most for), the mat lying on it.
      const size = 6 * extent;
      const plane = new THREE.Mesh(
        own.geo(new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2)),
        benchMat,
      );
      plane.position.set(cx, -MAT_T, cz);
      plane.receiveShadow = true;
      plane.name = 'base';
      plane.renderOrder = -1;
      if (grain) {
        // Grain at about 6 texels per mm, whatever the desk size.
        const rep = size / 40;
        grain.repeat.set(rep, rep);
      }
      if (full) g.add(plane);
      // The mat: the circuit's area with a generous margin (a real mat is larger than the build).
      const margin = Math.max(28, 0.3 * extent);
      const mx0 = b.minX - margin;
      const mx1 = b.maxX + margin;
      const mz0 = b.minZ - margin;
      const mz1 = b.maxZ + margin;
      const mat = new THREE.Mesh(own.geo(matGeometry(mx1 - mx0, mz1 - mz0)), [matMat, matEdgeMat]);
      mat.position.set((mx0 + mx1) / 2, 0, (mz0 + mz1) / 2);
      mat.receiveShadow = true;
      mat.name = 'mat';
      g.add(mat);
      // Printed on the mat: a faint 0.5 in grid over the circuit's area, and a millimetre scale
      // (5 mm ticks, longer every 10 mm) along its front edge.
      const lines: number[] = [];
      const y = 0.012;
      const gx0 = Math.ceil((b.minX - 6) / GRID_STEP_MM) * GRID_STEP_MM;
      const gz0 = Math.ceil((b.minZ - 6) / GRID_STEP_MM) * GRID_STEP_MM;
      for (let x = gx0; x <= b.maxX + 6; x += GRID_STEP_MM)
        lines.push(x, y, b.minZ - 6, x, y, b.maxZ + 6);
      for (let z = gz0; z <= b.maxZ + 6; z += GRID_STEP_MM)
        lines.push(b.minX - 6, y, z, b.maxX + 6, y, z);
      const scaleZ = mz1 - 5;
      for (let x = Math.ceil((mx0 + 12) / 5) * 5; x <= mx1 - 12; x += 5) {
        const long = Math.round(x / 5) % 2 === 0;
        lines.push(x, y, scaleZ, x, y, scaleZ - (long ? 3 : 1.6));
      }
      lines.push(mx0 + 12, y, scaleZ, mx1 - 12, y, scaleZ);
      const gridGeo = own.geo(new THREE.BufferGeometry());
      gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
      const grid = new THREE.LineSegments(gridGeo, gridMat);
      grid.name = 'grid';
      g.add(grid);
      // Contact shadows under the parts.
      const contact = contactShadows(desc, full ? 0.75 : 1);
      if (contact) {
        const m = new THREE.Mesh(own.geo(contact), contactMat);
        m.name = 'contact-shadows';
        m.renderOrder = 0;
        // As the labels (the same program variant in the full tier too).
        m.receiveShadow = true;
        m.userData.noAo = true;
        g.add(m);
      }
      return g;
    },
    dispose() {
      composer?.dispose();
      composer?.renderTarget1.dispose();
      composer?.renderTarget2.dispose();
      gtao?.dispose();
      env?.dispose();
      backdrop?.dispose();
      benchMat.alphaMap?.dispose();
      benchMat.map?.dispose();
      benchMat.dispose();
      grain?.dispose();
      matGrain?.dispose();
      matMat.dispose();
      matEdgeMat.dispose();
      contactMat.map?.dispose();
      contactMat.dispose();
      gridMat.dispose();
      key.shadow.map?.dispose();
    },
  };
}

/**
 * GTAO's normal/depth pass draws every mesh; a transparent one (an LED's epoxy, the glass of a
 * diode, a glow sprite) would then occlude what is seen through it. Hide those for that pass only.
 */
function excludeTransparentFromAo(pass: GTAOPass) {
  const p = pass as unknown as {
    scene: THREE.Scene;
    _visibilityCache: THREE.Object3D[];
    _overrideVisibility: () => void;
  };
  const original = p._overrideVisibility.bind(pass);
  p._overrideVisibility = () => {
    original();
    p.scene.traverse((o) => {
      if (!o.visible) return;
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      const transparent =
        (o as THREE.Sprite).isSprite ||
        (m !== undefined &&
          (Array.isArray(m)
            ? m.some((x) => x.transparent)
            : m.transparent || (m as THREE.MeshPhysicalMaterial).transmission > 0));
      if ((transparent || o.userData.noAo) && o.name !== 'base') {
        o.visible = false;
        p._visibilityCache.push(o);
      }
    });
  };
}

/**
 * The mat: a rounded rectangle w x d mm, MAT_T thick, its top at y = 0, a small rounded bevel on
 * the top edge. Group 0: the top (UVs in mm, for the grain); group 1: the edge and underside.
 */
export function matGeometry(w: number, d: number): THREE.BufferGeometry {
  const r = Math.min(MAT_CORNER, w / 4, d / 4);
  const shape = new THREE.Shape();
  const x0 = -w / 2;
  const z0 = -d / 2;
  shape.moveTo(x0 + r, z0);
  shape.lineTo(x0 + w - r, z0);
  shape.quadraticCurveTo(x0 + w, z0, x0 + w, z0 + r);
  shape.lineTo(x0 + w, z0 + d - r);
  shape.quadraticCurveTo(x0 + w, z0 + d, x0 + w - r, z0 + d);
  shape.lineTo(x0 + r, z0 + d);
  shape.quadraticCurveTo(x0, z0 + d, x0, z0 + d - r);
  shape.lineTo(x0, z0 + r);
  shape.quadraticCurveTo(x0, z0, x0 + r, z0);
  const bevel = 0.6;
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: MAT_T - 2 * bevel,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: 3,
    curveSegments: 6,
  });
  // Extruded along +z from the shape's plane: lay it down, top face up at y = 0.
  geo.rotateX(Math.PI / 2);
  geo.computeBoundingBox();
  geo.translate(0, -geo.boundingBox!.max.y, 0);
  // ExtrudeGeometry's groups: 0 the caps (top and bottom), 1 the sides; the top cap is group 0.
  return geo;
}

/** Contact-shadow strengths: one band of the atlas each (alpha at the centre). */
export const CONTACT_LEVELS = [0.22, 0.3, 0.38, 0.45] as const;

/**
 * Soft contact-shadow atlas: one 64 x 64 band per strength (CONTACT_LEVELS), each solid in its
 * middle square and fading to nothing at its rim (so neighbouring bands never bleed). Black, the
 * strength and softness in the alpha.
 */
function contactTexture(): THREE.Texture {
  const N = 64;
  const B = CONTACT_LEVELS.length;
  const t = new THREE.CanvasTexture(
    canvas(N, N * B, (ctx) => {
      const img = ctx.createImageData(N, N * B);
      for (let band = 0; band < B; band++)
        for (let y = 0; y < N; y++)
          for (let x = 0; x < N; x++) {
            // Distance outside the inner square [0.25, 0.75], in units of the 0.25 border.
            const u = (x + 0.5) / N;
            const v = (y + 0.5) / N;
            const dx = Math.max(0.25 - u, 0, u - 0.75) / 0.25;
            const dy = Math.max(0.25 - v, 0, v - 0.75) / 0.25;
            const d = Math.min(1, Math.hypot(dx, dy));
            // Canvas rows run down; texture v runs up: band k occupies v in [k / B, (k + 1) / B].
            const row = (B - 1 - band) * N + y;
            const i = (row * N + x) * 4;
            img.data[i] = 13;
            img.data[i + 1] = 17;
            img.data[i + 2] = 20;
            img.data[i + 3] = Math.round(255 * CONTACT_LEVELS[band]! * Math.pow(1 - d, 2.2));
          }
      ctx.putImageData(img, 0, 0);
    }),
  );
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * How each part darkens the mat where it stands: its body's half-length along its axis when the
 * footprint includes leads (axial parts, switches), the strength, and the softness (mm). A part on
 * standoffs (the ESP32 on its header pins) casts a broad, faint one.
 */
const CONTACT: Partial<Record<ModelKey, { half?: number; strength: number; soft: number }>> = {
  'board.esp32_devkitc': { strength: 0.32, soft: 7 },
  'resistor.axial': { half: 3.4, strength: 0.3, soft: 2.2 },
  'diode.axial': { half: 2.2, strength: 0.22, soft: 1.8 },
  'switch.tactile': { half: 3.2, strength: 0.4, soft: 2.2 },
  'switch.toggle': { half: 4.6, strength: 0.42, soft: 3 },
  'led.radial': { strength: 0.32, soft: 2.2 },
  'ground.post': { strength: 0.32, soft: 2 },
  'instrument.psu': { strength: 0.45, soft: 5 },
};

/**
 * One merged 9-slice quad per part (one draw call), mapped into the atlas band nearest its
 * strength (times `scale`).
 */
export function contactShadows(desc: SceneDescription, scale: number): THREE.BufferGeometry | null {
  const pos: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  const B = CONTACT_LEVELS.length;
  for (const c of desc.components) {
    const k = CONTACT[c.model] ?? { strength: 0.3, soft: 2.5 };
    const [fx0, fx1, z0, z1] = FOOTPRINT[c.model];
    const mid = (fx0 + fx1) / 2;
    const x0 = k.half !== undefined ? mid - k.half : fx0;
    const x1 = k.half !== undefined ? mid + k.half : fx1;
    const f = k.soft;
    // Outer rect (falloff ends), inner rect (full strength), in the part's own frame.
    const xs = [x0 - f / 2, x0 + f / 2, x1 - f / 2, x1 + f / 2];
    const zs = [z0 - f / 2, z0 + f / 2, z1 - f / 2, z1 + f / 2];
    if (xs[1]! > xs[2]!) xs[1] = xs[2] = (x0 + x1) / 2;
    if (zs[1]! > zs[2]!) zs[1] = zs[2] = (z0 + z1) / 2;
    const want = k.strength * scale;
    let band = 0;
    CONTACT_LEVELS.forEach((l, i) => {
      if (Math.abs(l - want) < Math.abs(CONTACT_LEVELS[band]! - want)) band = i;
    });
    const us = [0, 0.25, 0.75, 1];
    const base = pos.length / 3;
    for (let j = 0; j < 4; j++)
      for (let i = 0; i < 4; i++) {
        const p = rotatePoint({ x: xs[i]!, y: zs[j]! }, c.rotation);
        pos.push(c.x + p.x, 0.02, c.z + p.y);
        uv.push(us[i]!, (band + us[j]!) / B);
      }
    for (let j = 0; j < 3; j++)
      for (let i = 0; i < 3; i++) {
        const q = base + j * 4 + i;
        index.push(q, q + 4, q + 1, q + 1, q + 4, q + 5);
      }
  }
  if (!pos.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

function canvas(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  return c;
}

function gradientTexture(top: string, bottom: string): THREE.Texture {
  const t = new THREE.CanvasTexture(
    canvas(2, 64, (ctx) => {
      const g = ctx.createLinearGradient(0, 0, 0, 64);
      g.addColorStop(0, top);
      g.addColorStop(1, bottom);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 2, 64);
    }),
  );
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Alpha of the bench: opaque over most of it, fading out over its outer third. */
function radialFade(): THREE.Texture {
  const t = new THREE.CanvasTexture(
    canvas(128, 128, (ctx) => {
      const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.55, '#ffffff');
      g.addColorStop(1, '#000000');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 128, 128);
    }),
  );
  return t;
}

/** Fine matte grain (value noise), deterministic, tileable: a 256 px texture. */
function grainTexture(): THREE.Texture {
  const N = 256;
  const t = new THREE.CanvasTexture(
    canvas(N, N, (ctx) => {
      const img = ctx.createImageData(N, N);
      let seed = 1234567;
      const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      // Two octaves: a coarse mottle (wrapped bilinear grid of 16) and per-texel grain.
      const G = 16;
      const coarse = Array.from({ length: G * G }, rnd);
      const at = (x: number, y: number) => coarse[((y + G) % G) * G + ((x + G) % G)]!;
      for (let y = 0; y < N; y++)
        for (let x = 0; x < N; x++) {
          const fx = (x / N) * G;
          const fy = (y / N) * G;
          const x0 = Math.floor(fx);
          const y0 = Math.floor(fy);
          const tx = fx - x0;
          const ty = fy - y0;
          const c =
            at(x0, y0) * (1 - tx) * (1 - ty) +
            at(x0 + 1, y0) * tx * (1 - ty) +
            at(x0, y0 + 1) * (1 - tx) * ty +
            at(x0 + 1, y0 + 1) * tx * ty;
          const v = Math.round(200 + 30 * (c - 0.5) + 40 * (rnd() - 0.5));
          const i = (y * N + x) * 4;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
          img.data[i + 3] = 255;
        }
      ctx.putImageData(img, 0, 0);
    }),
  );
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** A soft radial falloff (centre 100 %, rim about 90 %) for the bench's colour. */
function falloffTexture(): THREE.Texture {
  const t = new THREE.CanvasTexture(
    canvas(128, 128, (ctx) => {
      const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.25, '#eeeeee');
      g.addColorStop(0.6, '#e2e2e2');
      g.addColorStop(1, '#dadada');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 128, 128);
    }),
  );
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** How strongly the studio lights the scene's reflections (full tier). */
const STUDIO_INTENSITY = 0.85;

/**
 * The studio the environment map is rendered from (scene units are arbitrary: only directions
 * matter to an environment). HDR values above 1 make the softboxes read as light sources.
 */
function studioScene(): THREE.Scene {
  const s = new THREE.Scene();
  // Sky dome: light grey above, a soft horizon, a darker floor below (the bench's own tone).
  const dome = new THREE.SphereGeometry(50, 48, 24);
  const colors: number[] = [];
  const top = new THREE.Color('#eceef0');
  const horizon = new THREE.Color('#c4c8cc');
  const floor = new THREE.Color('#7e8286');
  const pos = dome.attributes.position!;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 50;
    const c =
      y >= 0
        ? horizon.clone().lerp(top, Math.pow(y, 0.6))
        : horizon.clone().lerp(floor, Math.min(1, -y * 3));
    colors.push(c.r, c.g, c.b);
  }
  dome.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  s.add(
    new THREE.Mesh(dome, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })),
  );
  const panel = (
    w: number,
    h: number,
    power: number,
    at: [number, number, number],
    look: [number, number, number],
  ) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(power, power, power),
        side: THREE.DoubleSide,
      }),
    );
    m.position.set(...at);
    m.lookAt(...look);
    s.add(m);
  };
  // The overhead softbox, slightly behind (the key light's side), and two tall strips.
  panel(34, 20, 3.2, [-4, 40, -8], [0, 0, 0]);
  panel(7, 30, 2.4, [-38, 16, -6], [0, 6, 0]);
  panel(7, 30, 1.6, [34, 18, -22], [0, 6, 0]);
  // A low front card: a gentle fill on faces turned to the viewer.
  panel(40, 9, 0.7, [0, 8, 44], [0, 4, 0]);
  return s;
}

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
 * Bench: a large matte surface that fades into the background at its edges (no horizon line), a
 * restrained 0.5 in grid over the circuit's area, and a soft gradient backdrop.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { OwnedResources } from './kit.js';
import type { SceneDescription } from './scene.js';

export type Tier = 'full' | 'reduced';

/** Bench and backdrop colours (sRGB). A cool, light neutral grey: parts and wire colours read true. */
const BENCH = '#b8bdc3';
const BACKDROP_TOP = '#f1f3f5';
const BACKDROP_BOTTOM = '#cfd3d8';
const GRID = '#aab1b9';
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
  renderer.setClearColor(BACKDROP_BOTTOM);

  // Lights. A warm key light high from the back left (seen from the default camera its shadows
  // fall forward, where they read as contact with the bench), a cool fill from the front right,
  // a low rim for highlights on metal; full: the environment does most of the remaining fill.
  const hemi = new THREE.HemisphereLight('#ffffff', '#9aa1a8', full ? 0.1 : 1.35);
  const key = new THREE.DirectionalLight('#fff6ea', full ? 2.7 : 2.1);
  key.castShadow = full;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 2.5;
  key.shadow.blurSamples = 16;
  const fill = new THREE.DirectionalLight('#e6eeff', full ? 0.35 : 0.55);
  const rim = new THREE.DirectionalLight('#ffffff', full ? 0.5 : 0.6);
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

  /** Bench texture: a fine, non-repeating-looking matte grain (bump and roughness). */
  let grain: THREE.Texture | null = null;
  // Full tier: the bench fades out towards its rim (alpha), so no horizon line shows. Reduced
  // tier: opaque (a blended full-screen plane is costly on a software rasteriser), its size
  // limited to the circuit's surroundings.
  const benchMat = new THREE.MeshStandardMaterial({
    color: BENCH,
    roughness: 0.94,
    metalness: 0,
    transparent: full,
    alphaMap: full ? radialFade() : null,
    depthWrite: true,
  });
  if (full) {
    // A bench lit from above is a little brighter under the lamp than at its rim (soft falloff).
    benchMat.map = falloffTexture();
    grain = grainTexture();
    benchMat.bumpMap = grain;
    benchMat.bumpScale = 0.4;
    benchMat.roughnessMap = grain;
  }
  const gridMat = new THREE.LineBasicMaterial({ color: GRID, transparent: true, opacity: 0.55 });

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
      // Large enough that its faded rim lies well outside any view of the circuit.
      const size = (full ? 6 : 1.6) * Math.max(b.maxX - b.minX, b.maxZ - b.minZ, 80);
      const plane = new THREE.Mesh(
        own.geo(new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2)),
        benchMat,
      );
      plane.position.set(cx, 0, cz);
      plane.receiveShadow = true;
      plane.name = 'base';
      plane.renderOrder = -1;
      if (grain) {
        // Grain at about 6 texels per mm, whatever the bench size.
        const rep = size / 40;
        grain.repeat.set(rep, rep);
      }
      g.add(plane);
      // The grid over the circuit's area only (0.5 in), a hair above the bench.
      const lines: number[] = [];
      for (let x = Math.ceil(b.minX / GRID_STEP_MM) * GRID_STEP_MM; x <= b.maxX; x += GRID_STEP_MM)
        lines.push(x, 0.01, b.minZ, x, 0.01, b.maxZ);
      for (let z = Math.ceil(b.minZ / GRID_STEP_MM) * GRID_STEP_MM; z <= b.maxZ; z += GRID_STEP_MM)
        lines.push(b.minX, 0.01, z, b.maxX, 0.01, z);
      const gridGeo = own.geo(new THREE.BufferGeometry());
      gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
      const grid = new THREE.LineSegments(gridGeo, gridMat);
      grid.name = 'grid';
      g.add(grid);
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
const STUDIO_INTENSITY = 0.75;

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

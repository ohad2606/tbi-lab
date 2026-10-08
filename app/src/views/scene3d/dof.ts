/**
 * Depth of field for the full tier (realism pass 7): what a camera close to a small subject
 * does. One full-screen pass that reads the depth buffer the AO pass already renders (no extra
 * scene render).
 *
 * - Focus: the orbit target, or, nearer, what is at the middle of the frame (five taps, the
 *   nearest wins), like a camera's centre autofocus: whatever the user zooms towards is what is
 *   sharp. Never beyond the orbit target (a patch of mat behind the subject must not pull the
 *   focus past it) and never nearer than DOF_FOCUS_RANGE times closer (a lead passing close to
 *   the lens must not throw the bench out of focus).
 * - Strength: a fixed lens: the circle of confusion grows with |1 - focus / depth| and shrinks
 *   as the focus distance grows, so close-ups (a 5 mm LED from 40 mm) have shallow depth and the
 *   whole bench (focus ~250 mm) stays sharp. Capped.
 * - Gather blur on a golden-angle disk; each sample counts only as far as its own blur reaches
 *   the centre pixel, so a sharp subject does not bleed into a blurred background.
 */
import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

/** Circle of confusion (fraction of the frame's height) of the lens focused at DOF_REF_MM. */
export const DOF_APERTURE = 0.012;
export const DOF_REF_MM = 60;
/** Largest blur radius (fraction of the frame's height). */
export const DOF_MAX = 0.006;
/** The autofocus comes no nearer than the orbit distance divided by this. */
export const DOF_FOCUS_RANGE = 1.5;
const TAPS = 16;

/** The autofocus distance: the centre's depth, between the orbit distance and 1/RANGE of it. */
export function autofocus(centreDepth: number, orbitDistance: number): number {
  return Math.min(orbitDistance, Math.max(orbitDistance / DOF_FOCUS_RANGE, centreDepth));
}

/** Circle-of-confusion radius (fraction of the frame's height) at view distance `depth` (mm). */
export function circleOfConfusion(depth: number, focus: number): number {
  const strength = DOF_APERTURE * Math.min(1, DOF_REF_MM / focus);
  return Math.min(DOF_MAX, strength * Math.abs(1 - focus / Math.max(depth, 1e-6)));
}

export function createDofPass(depthTexture: THREE.Texture, camera: THREE.PerspectiveCamera) {
  const pass = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      tDepth: { value: null },
      cameraNear: { value: camera.near },
      cameraFar: { value: camera.far },
      orbit: { value: 100 },
      aspect: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      #include <packing>
      uniform sampler2D tDiffuse;
      uniform sampler2D tDepth;
      uniform float cameraNear, cameraFar, orbit, aspect;
      varying vec2 vUv;
      const float APERTURE = ${DOF_APERTURE.toFixed(6)};
      const float REF = ${DOF_REF_MM.toFixed(1)};
      const float MAX_COC = ${DOF_MAX.toFixed(6)};
      const float RANGE = ${DOF_FOCUS_RANGE.toFixed(3)};
      float viewDepth(vec2 uv) {
        return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, cameraNear, cameraFar);
      }
      void main() {
        // Autofocus: the nearest of five taps round the frame's centre, no farther than the orbit.
        float d = viewDepth(vec2(0.5));
        d = min(d, viewDepth(vec2(0.47, 0.5)));
        d = min(d, viewDepth(vec2(0.53, 0.5)));
        d = min(d, viewDepth(vec2(0.5, 0.47)));
        d = min(d, viewDepth(vec2(0.5, 0.53)));
        float focus = clamp(d, orbit / RANGE, orbit);
        float strength = APERTURE * min(1.0, REF / focus);
        vec4 centre = texture2D(tDiffuse, vUv);
        float c0 = min(MAX_COC, strength * abs(1.0 - focus / max(viewDepth(vUv), 1e-4)));
        if (c0 < 0.0004) { gl_FragColor = centre; return; }
        vec3 sum = centre.rgb;
        float weight = 1.0;
        const float GOLDEN = 2.39996323;
        for (int i = 0; i < ${TAPS}; i++) {
          float r = sqrt((float(i) + 0.5) / float(${TAPS}));
          float a = float(i) * GOLDEN;
          vec2 uv = vUv + vec2(cos(a) / aspect, sin(a)) * r * c0;
          float cs = min(MAX_COC, strength * abs(1.0 - focus / max(viewDepth(uv), 1e-4)));
          // A sample contributes only as far as its own blur reaches this pixel.
          float w = clamp(cs / max(r * c0, 1e-5), 0.0, 1.0);
          sum += texture2D(tDiffuse, uv).rgb * w;
          weight += w;
        }
        gl_FragColor = vec4(sum / weight, centre.a);
      }`,
  });
  // ShaderPass clones its uniforms, textures included: the clone would be an empty texture,
  // not the AO pass's depth buffer. Bind the real one.
  pass.uniforms.tDepth!.value = depthTexture;
  return {
    pass,
    /** Per frame: the orbit distance (camera to target), the frame's aspect, the depth range. */
    update(orbitDistance: number, aspect: number) {
      const u = pass.uniforms;
      u.orbit!.value = orbitDistance;
      u.aspect!.value = aspect;
      u.cameraNear!.value = camera.near;
      u.cameraFar!.value = camera.far;
    },
  };
}

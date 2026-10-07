/**
 * Which graphics the 3D view runs on (Sprint 10): the browser's own WebGL renderer string and the
 * quality tier the 3D view picks for it. Shown locally in the build details (owner review needs
 * to know whether a screen was rendered on a real GPU); never sent anywhere. No three.js here.
 */
export type RenderTier = 'full' | 'reduced';

export const QUALITY_KEY = 'tbi-lab.3d.quality';
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render/i;

/**
 * The tier for a renderer name (UNMASKED_RENDERER_WEBGL) and an optional per-browser override:
 * software rasterisers get `reduced`, every real GPU `full`. By capability, never by brand.
 */
export function chooseQuality(renderer: string, override: string | null): RenderTier {
  if (override === 'full' || override === 'reduced') return override;
  return SOFTWARE_RENDERER.test(renderer) ? 'reduced' : 'full';
}

/** Probe WebGL once: its renderer name and tier, or null without WebGL. Releases the context. */
export function probeGpu(): { renderer: string; tier: RenderTier } | null {
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
    const renderer = String(
      info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    );
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { renderer, tier: chooseQuality(renderer, override) };
  } catch {
    return null;
  }
}

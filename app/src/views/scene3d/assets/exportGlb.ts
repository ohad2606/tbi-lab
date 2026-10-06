/**
 * Binary glTF export of an authored asset (build time, Node). three's GLTFExporter reads Blobs
 * through FileReader, which Node does not provide: a minimal one is installed for the call.
 */
import type * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

class NodeFileReader {
  result: ArrayBuffer | string | null = null;
  onloadend: (() => void) | null = null;
  readAsArrayBuffer(blob: Blob) {
    void blob.arrayBuffer().then((r) => {
      this.result = r;
      this.onloadend?.();
    });
  }
  readAsDataURL(blob: Blob) {
    void blob.arrayBuffer().then((r) => {
      this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(r).toString('base64')}`;
      this.onloadend?.();
    });
  }
}

export async function exportGlb(root: THREE.Object3D): Promise<Uint8Array> {
  const g = globalThis as { FileReader?: unknown };
  const had = g.FileReader;
  g.FileReader ??= NodeFileReader;
  try {
    const out = await new GLTFExporter().parseAsync(root, { binary: true });
    return new Uint8Array(out as ArrayBuffer);
  } finally {
    if (!had) delete g.FileReader;
  }
}

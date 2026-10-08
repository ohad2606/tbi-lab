/**
 * A jumper wire's female 2.54 mm crimp housing ("Dupont"), as plugged on a header pin (Sprint 10
 * realism pass). Procedural; reused by any part with male header pins.
 *
 * The real part: a square glass-filled nylon tube, 2.54 x 2.54 x 14 mm, chamfered at the wire end,
 * with the locking-lance window on one face through which the tinned crimp terminal shows, and the
 * square pin entry at the other end [REP]. The wire's insulation enters the chamfered end through
 * a square opening, where the terminal's insulation crimp (two tinned wings folded round the
 * jacket) sits just inside (realism pass 4: the opening, the crimp and the lance are drawn).
 *
 * Local frame: the housing's axis on +Y, its pin end at y = 0, its wire end at y = height; the
 * latch window faces +Z.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { OwnedResources, mesh } from '../kit.js';

export interface DupontMaterials {
  housing: THREE.Material;
  dark: THREE.Material;
  metal: THREE.Material;
}

/** The housing's look, one set per viewer. */
export function dupontMaterials(own: OwnedResources): DupontMaterials {
  return {
    housing: own.lastingMat(
      'dupont:housing',
      () =>
        new THREE.MeshPhysicalMaterial({
          // Realism pass 6: glass-filled nylon is a charcoal black, not a void: its rounded
          // edges catch the light the way a camera sees them.
          color: '#18181b',
          roughness: 0.46,
          sheen: 0.3,
          sheenRoughness: 0.6,
          sheenColor: new THREE.Color('#3a3d42'),
        }),
    ),
    dark: own.lastingMat(
      'dupont:dark',
      () => new THREE.MeshStandardMaterial({ color: '#040405', roughness: 0.9 }),
    ),
    metal: own.lastingMat(
      'dupont:crimp',
      () => new THREE.MeshStandardMaterial({ color: '#c9ccd0', metalness: 1, roughness: 0.3 }),
    ),
  };
}

/** One housing (size x size x height mm), its pin end at the local origin. */
export function buildDupont(
  own: OwnedResources,
  size: number,
  height: number,
  m: DupontMaterials,
): THREE.Group {
  const g = new THREE.Group();
  const chamfer = 0.7;
  const bodyH = height - chamfer;
  const body = own.shared(`dupont:body:${size}:${height}`, () => {
    const main = new RoundedBoxGeometry(size, bodyH, size, 2, 0.14).translate(0, bodyH / 2, 0);
    // The wire end: a square frustum (a four-sided cylinder turned 45 degrees).
    const top = new THREE.CylinderGeometry(
      (size * 0.72) / Math.SQRT2,
      (size - 0.04) / Math.SQRT2,
      chamfer,
      4,
      1,
    )
      .rotateY(Math.PI / 4)
      .translate(0, bodyH + chamfer / 2, 0);
    for (const geo of [main, top]) {
      for (const k of Object.keys(geo.attributes))
        if (k !== 'position' && k !== 'normal') geo.deleteAttribute(k);
    }
    const merged = mergeGeometries([main.toNonIndexed(), top.toNonIndexed()], false)!;
    main.dispose();
    top.dispose();
    return merged;
  });
  const shell = mesh(body, m.housing);
  shell.userData.dupontBody = true;
  g.add(shell);
  // The locking-lance window (+Z face): a recess, the terminal's tinned barrel in it, and the
  // lance (a tab stamped out of the barrel, bent outward) catching the window's upper edge.
  const winH = 3.2;
  const winY = height * 0.32;
  const win = mesh(
    own.shared(`dupont:window:${size}`, () => new THREE.BoxGeometry(size * 0.56, winH, 0.06)),
    m.dark,
    [0, winY, size / 2 + 0.005],
  );
  win.castShadow = false;
  g.add(win);
  const crimp = mesh(
    own.shared(`dupont:crimp:${size}`, () => new THREE.BoxGeometry(size * 0.34, winH - 0.7, 0.05)),
    m.metal,
    [0, winY - 0.2, size / 2 + 0.02],
  );
  crimp.castShadow = false;
  g.add(crimp);
  const lance = mesh(
    own.shared(`dupont:lance:${size}`, () =>
      new THREE.BoxGeometry(size * 0.26, 0.9, 0.05).translate(0, -0.45, 0).rotateX(-0.35),
    ),
    m.metal,
    [0, winY + winH / 2 - 0.15, size / 2 + 0.03],
  );
  lance.castShadow = false;
  g.add(lance);
  // The wire end: a square opening in the chamfer's top, the insulation crimp's folded wings just
  // inside it round the jacket.
  const open = mesh(
    own.shared(
      `dupont:opening:${size}`,
      () => new THREE.BoxGeometry(size * 0.66, 0.04, size * 0.66),
    ),
    m.dark,
    [0, height + 0.005, 0],
  );
  open.castShadow = false;
  g.add(open);
  const wings = mesh(
    own.shared(`dupont:wings:${size}`, () =>
      new THREE.CylinderGeometry(0.78, 0.82, 0.5, 14, 1, true).translate(0, -0.2, 0),
    ),
    m.metal,
    [0, height, 0],
  );
  wings.castShadow = false;
  g.add(wings);
  // The square pin entry at the bottom.
  const entry = mesh(
    own.shared(`dupont:entry:${size}`, () => new THREE.BoxGeometry(size * 0.42, 0.04, size * 0.42)),
    m.dark,
    [0, -0.015, 0],
  );
  entry.castShadow = false;
  g.add(entry);
  return g;
}

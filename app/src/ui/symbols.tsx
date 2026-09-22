/**
 * Schematic symbols, drawn in component-local schematic units at rotation 0. Terminal
 * positions come from the domain catalog; the drawings here must end their leads exactly on
 * those points. Symbols contain no text at all, so they read correctly at every rotation.
 */

import type { ComponentTypeId } from '@tbi-lab/domain';

export interface SymbolDef {
  /** Local bounding box [minX, minY, maxX, maxY] at rotation 0, including leads. */
  bbox: [number, number, number, number];
  draw: () => preact.JSX.Element;
}

export const SYMBOLS: Record<ComponentTypeId, SymbolDef> = {
  'component.resistor': {
    bbox: [-40, -10, 40, 10],
    draw: () => (
      <>
        <line x1={-40} y1={0} x2={-24} y2={0} />
        <polyline points="-24,0 -20,-8 -12,8 -4,-8 4,8 12,-8 20,8 24,0" />
        <line x1={24} y1={0} x2={40} y2={0} />
      </>
    ),
  },
  'component.ground': {
    bbox: [-16, -20, 16, 12],
    draw: () => (
      <>
        <line x1={0} y1={-20} x2={0} y2={0} />
        <line x1={-16} y1={0} x2={16} y2={0} />
        <line x1={-10} y1={6} x2={10} y2={6} />
        <line x1={-4} y1={12} x2={4} y2={12} />
      </>
    ),
  },
  'instrument.lab_psu': {
    bbox: [-40, -40, 40, 40],
    draw: () => (
      <>
        <rect x={-40} y={-40} width={60} height={80} rx={4} class="symbol-body" />
        <line x1={20} y1={-20} x2={40} y2={-20} />
        <line x1={20} y1={20} x2={40} y2={20} />
        {/* + and − drawn as geometry, not text, so they stay correct under rotation. */}
        <line x1={4} y1={-20} x2={14} y2={-20} />
        <line x1={9} y1={-25} x2={9} y2={-15} />
        <line x1={4} y1={20} x2={14} y2={20} />
        {/* DC mark (⎓): a solid line over a dashed line. */}
        <line x1={-30} y1={-3} x2={-10} y2={-3} />
        <line x1={-30} y1={4} x2={-24} y2={4} />
        <line x1={-23} y1={4} x2={-17} y2={4} />
        <line x1={-16} y1={4} x2={-10} y2={4} />
      </>
    ),
  },
};

/**
 * RGB LED (Sprint 10): three independent LED dice on a common cathode, each its own `Diode` with
 * its own datasheet-fitted card (models.ts RGB_WP154A4SUREQBFZGC). The channels share only the
 * cathode node: each channel's current is solved from the circuit on its own anode, so mixing is
 * whatever the circuit drives, never a selected colour.
 */
import { Diode } from '../devices.js';
import { RGB_WP154A4SUREQBFZGC } from '../models.js';
import { registerPart, validateCard, type PartModel } from '../parts.js';

export const RGB_CHANNELS = ['red', 'green', 'blue'] as const;
export type RgbChannel = (typeof RGB_CHANNELS)[number];

const MODEL_ID = 'model.rgb_led.kingbright_wp154a4sureqbfzgc';

/** Forward-current span of the graph readings each channel was fitted to (models.ts). */
export const RGB_VALID_CURRENT_A: Readonly<Record<RgbChannel, readonly [number, number]>> = {
  red: [2e-3, 30e-3],
  green: [2e-3, 25e-3],
  blue: [2e-3, 30e-3],
};

/**
 * Absolute maximum ratings at T_A = 25 degC (datasheet page 2): DC forward current, reverse
 * voltage, power dissipation, per die.
 */
export const RGB_RATINGS: Readonly<
  Record<RgbChannel, { forwardCurrentA: number; reverseVoltageV: number; powerW: number }>
> = {
  red: { forwardCurrentA: 0.03, reverseVoltageV: 5, powerW: 0.075 },
  green: { forwardCurrentA: 0.025, reverseVoltageV: 5, powerW: 0.1025 },
  blue: { forwardCurrentA: 0.03, reverseVoltageV: 5, powerW: 0.12 },
};

const cards = { [MODEL_ID]: { partNumber: 'WP154A4SUREQBFZGC' } };

export const RGB_LED: PartModel = {
  terminals: ['red', 'green', 'blue', 'cathode'],
  cards,
  validate: (ctx) => validateCard(ctx, cards),
  elements: (ctx) =>
    RGB_CHANNELS.map((ch) => {
      const key = `${ctx.component.id}/${ch}`;
      const nodes: [string, string] = [ctx.node(ch), ctx.node('cathode')];
      return {
        kind: 'device' as const,
        key,
        nodes,
        make: () => new Diode(key, nodes[0], nodes[1], RGB_WP154A4SUREQBFZGC[ch]),
      };
    }),
  report: (ctx, _state, sol) => {
    const currents: Record<string, number> = {};
    let outside = false;
    for (const ch of RGB_CHANNELS) {
      const i = sol.deviceCurrent(`${ctx.component.id}/${ch}`);
      currents[ch] = i;
      const [lo, hi] = RGB_VALID_CURRENT_A[ch];
      // Below ~1 uA a die is simply off; the flag concerns meaningful conduction.
      if (i > 1e-6 && (i < lo || i > hi)) outside = true;
    }
    const terminals: Record<string, number | null> = {};
    for (const t of RGB_LED.terminals) terminals[t] = sol.potential(t);
    return {
      current: null,
      voltage: null,
      terminals,
      currents,
      ...(Object.values(currents).some((i) => i > 1e-6) ? { outsideModelRange: outside } : {}),
    };
  },
  ratings: (_params, r) => {
    const out: ReturnType<NonNullable<PartModel['ratings']>> = [];
    const k = r.terminals.cathode;
    for (const ch of RGB_CHANNELS) {
      const i = r.currents?.[ch];
      const a = r.terminals[ch];
      if (i === undefined || i === null) continue;
      const lim = RGB_RATINGS[ch];
      const v = a !== null && a !== undefined && k !== null && k !== undefined ? a - k : null;
      if (i > lim.forwardCurrentA)
        out.push({ code: 'forward_current', value: i, limit: lim.forwardCurrentA, channel: ch });
      if (v !== null && -v > lim.reverseVoltageV)
        out.push({ code: 'reverse_voltage', value: -v, limit: lim.reverseVoltageV, channel: ch });
      if (v !== null && Math.abs(v * i) > lim.powerW)
        out.push({ code: 'power', value: Math.abs(v * i), limit: lim.powerW, channel: ch });
    }
    return out;
  },
};

registerPart('component.rgb_led', RGB_LED);

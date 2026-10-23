/**
 * L2: truth-table / state inspection for logic parts (single gates and packaged devices). Shows
 * ONLY what the engine decided (`ComponentResult.logic`): each pin's level as the device model
 * classified it against the datasheet thresholds at the solved supply, and the measured pin
 * voltage relative to the part's own GND pin. An input between V_IL and V_IH is shown as
 * "undefined", never as a guessed level; a pin on an unknown net shows no voltage.
 *
 * The truth table is the device's logic function (the datasheet's function table); the rows the
 * gates are in right now are marked, and only when every input of that gate is defined.
 * Technical content (pin names, voltages, H/L) is LTR-isolated; the layout follows the locale.
 */
import { evaluate, type LogicInspection, type LogicPinState } from '@tbi-lab/engine';
import { isolateLtr } from '../i18n/i18n.js';
import type { MessageKey } from '../i18n/messages.en.js';
import { datasheetPinName, formatResult } from '../sim/format.js';
import { useAppState, useT } from './context.js';

/** The level text key for one pin. */
function levelKey(p: LogicPinState, input: boolean, rowKnown: boolean): MessageKey {
  if (p.level === 'high') return 'logic.inspect.level.high';
  if (p.level === 'low') return 'logic.inspect.level.low';
  if (p.level === 'off') return 'logic.inspect.level.off';
  // X: an input with a measured voltage lies between V_IL and V_IH (or the supply has no row);
  // anything without a voltage is on a net an unknown output reaches.
  if (input && p.volts !== null)
    return rowKnown ? 'logic.inspect.level.undefined' : 'logic.inspect.level.noThresholds';
  return 'logic.inspect.level.unknown';
}

/** Datasheet pin name: `a` → A, `y1` → 1Y. */
const pinName = datasheetPinName;

export function LogicStateView({ logic }: { logic: LogicInspection }) {
  const { locale } = useAppState();
  const t = useT();
  const V = (v: number | null) => (v === null ? '—' : formatResult(locale, v, 'volt'));
  const rowKnown = logic.vih !== null && logic.vil !== null;
  const nInputs = logic.gates[0]?.inputs.length ?? 0;
  const combos = Array.from({ length: 1 << nInputs }, (_, m) =>
    Array.from({ length: nInputs }, (_, i) => ((m >> (nInputs - 1 - i)) & 1) === 1),
  );
  // Which gates sit on each truth-table row right now (all their inputs defined).
  const at = (combo: boolean[]) =>
    logic.gates
      .filter((g) =>
        g.inputs.every(
          (p, i) => (p.level === 'high' || p.level === 'low') && (p.level === 'high') === combo[i],
        ),
      )
      .map((g) => g.unit);
  const inputLetters = (logic.gates[0]?.inputs ?? []).map((p) => pinName(p.pin.replace(/\d$/, '')));
  // The datasheet's own pin letters (A, B, Y), from the part's pins (technical, not translated).
  const outputLetter = pinName((logic.gates[0]?.output.pin ?? '').replace(/\d$/, ''));
  return (
    <section class="logic-state" data-testid="logic-state">
      <h4>{t('logic.inspect.title')}</h4>
      <p class="muted small" data-testid="logic-thresholds">
        {rowKnown
          ? t('logic.inspect.thresholds', {
              supply: isolateLtr(V(logic.supplyV)),
              vih: isolateLtr(V(logic.vih)),
              vil: isolateLtr(V(logic.vil)),
              part: isolateLtr(logic.partNumber),
            })
          : t('logic.inspect.noRow', { part: isolateLtr(logic.partNumber) })}
      </p>
      <table class="logic-pins" data-testid="logic-pins">
        <thead>
          <tr>
            <th scope="col">{t('logic.inspect.gate')}</th>
            <th scope="col">{t('logic.inspect.pin')}</th>
            <th scope="col">{t('logic.inspect.level')}</th>
            <th scope="col">{t('logic.inspect.voltage')}</th>
          </tr>
        </thead>
        <tbody>
          {logic.gates.flatMap((g) =>
            [...g.inputs.map((p) => [p, true] as const), [g.output, false] as const].map(
              ([p, input]) => (
                <tr
                  key={p.pin}
                  data-testid={`logic-pin-${p.pin}`}
                  data-level={p.level}
                  class={`logic-level-${p.level}`}
                >
                  <td class="technical" dir="ltr">
                    {g.unit || '—'}
                  </td>
                  <td class="technical" dir="ltr">
                    {pinName(p.pin)}
                  </td>
                  <td data-testid={`logic-level-${p.pin}`}>{t(levelKey(p, input, rowKnown))}</td>
                  <td class="technical" dir="ltr" data-testid={`logic-volts-${p.pin}`}>
                    {V(p.volts)}
                  </td>
                </tr>
              ),
            ),
          )}
        </tbody>
      </table>
      <h4>{t('logic.inspect.truthTable', { fn: isolateLtr(logic.function.toUpperCase()) })}</h4>
      <table class="logic-truth" data-testid="logic-truth" dir="ltr">
        <thead>
          <tr>
            {inputLetters.map((l) => (
              <th key={l} scope="col" class="technical">
                {l}
              </th>
            ))}
            <th scope="col" class="technical">
              {outputLetter}
            </th>
            <th scope="col" dir="auto">
              {t('logic.inspect.gatesHere')}
            </th>
          </tr>
        </thead>
        <tbody>
          {combos.map((combo) => {
            const here = at(combo);
            const key = combo.map((b) => (b ? 'H' : 'L')).join('');
            return (
              <tr
                key={key}
                data-testid={`logic-truth-${key}`}
                class={here.length ? 'active' : undefined}
                aria-current={here.length ? 'true' : undefined}
              >
                {combo.map((b, i) => (
                  <td key={i} class="technical">
                    {b ? 'H' : 'L'}
                  </td>
                ))}
                <td class="technical">{evaluate(logic.function, combo) ? 'H' : 'L'}</td>
                <td class="technical" data-testid={`logic-truth-gates-${key}`}>
                  {here.length ? here.map((u) => u || '●').join(', ') : ''}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p class="muted small">{t('logic.inspect.note')}</p>
    </section>
  );
}

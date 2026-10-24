/**
 * Logic panel in the Inspector (L2 state inspection; Sprint 20 Phase 5 UX). Shown whenever a
 * logic part (single gate or package) is selected, running or not:
 *
 * - the device's function table (its datasheet truth table), always; while running, the row the
 *   selected gate is in is highlighted and every gate's row is listed;
 * - the datasheet input thresholds: the rows by supply when not running, the solved V_CC with its
 *   V_IH / V_IL while running;
 * - per pin of the selected gate: level, voltage to the part's OWN GND pin, and WHY (the measured
 *   voltage against the threshold at that supply, the function for an output, or the refusal);
 * - a gate selector for packages (compact: each gate's state on its button);
 * - the inputs the user can operate from here (toggle switches, push buttons on an input's net)
 *   and which inputs an ESP32 GPIO drives, so the result updates without leaving the panel.
 *
 * Shows ONLY what the engine decided (`ComponentResult.logic`) or what the refusal names: an input
 * outside the defined bands is never shown as a level. Technical content (pin names, voltages,
 * H/L) is LTR-isolated; the layout follows the locale.
 */
import { useState } from 'preact/hooks';
import { CATALOG, type ComponentInstance, type ProjectDocument } from '@tbi-lab/domain';
import {
  evaluate,
  LOGIC_PACKAGE_CARDS,
  LVC1G_CARDS,
  type EngineError,
  type LogicCard,
  type LogicInspection,
  type LogicPinState,
} from '@tbi-lab/engine';
import { formatNumber, isolateLtr, type LocaleInfo } from '../i18n/i18n.js';
import type { MessageKey } from '../i18n/messages.en.js';
import { datasheetPinName, formatResult } from '../sim/format.js';
import { useAppState, useStore, useT } from './context.js';
import { controlKind, pressControl, toggleControl } from './controls.js';

/** Logic part types (catalog `logic.*`). */
export const isLogicType = (type: string) => type.startsWith('logic.');

interface GateSpec {
  unit: string;
  inputs: string[];
  output: string;
}

/** The device card and its gates, from the engine's datasheet cards (by the part's model). */
function deviceOf(c: ComponentInstance): { card: LogicCard; gates: GateSpec[] } | null {
  const model = String(c.params.model ?? '');
  const pkg = LOGIC_PACKAGE_CARDS[model];
  if (pkg)
    return {
      card: pkg,
      gates: pkg.units.map((u) => ({ unit: u.unit, inputs: [...u.inputs], output: u.output })),
    };
  const one = LVC1G_CARDS[model];
  if (one) return { card: one, gates: [{ unit: '', inputs: [...one.inputs], output: 'y' }] };
  return null;
}

const pinName = datasheetPinName;
const HL = (b: boolean) => (b ? 'H' : 'L');

/** What the panel knows about one pin. */
interface PinView {
  pin: string;
  input: boolean;
  /** Level text key and a short state for styling/testing. */
  state:
    | 'high'
    | 'low'
    | 'off'
    | 'undefined'
    | 'floating'
    | 'out_of_range'
    | 'unsupported'
    | 'unknown'
    | 'not_simulated'
    | 'idle';
  volts: number | null;
  why: string;
}

export function LogicStateView({
  component,
  logic,
  failure,
  running,
}: {
  component: ComponentInstance;
  /** The engine's inspection of this part in the current operating point, if solved. */
  logic: LogicInspection | null;
  /** The engine refusal that names this part, if the run was refused because of it. */
  failure: EngineError | null;
  running: boolean;
}) {
  const { locale, doc, sim, readOnly } = useAppState();
  const pressed = sim.status === 'running' ? sim.pressed : [];
  const t = useT();
  const [sel, setSel] = useState(0);
  const dev = deviceOf(component);
  if (!dev || !doc) return null;
  const { card, gates } = dev;
  const gi = Math.min(sel, gates.length - 1);
  const gate = gates[gi]!;
  const V = (v: number | null | undefined) =>
    v === null || v === undefined ? '—' : formatResult(locale, v, 'volt');
  const fn = card.function.toUpperCase();
  const rowKnown = !!logic && logic.vih !== null && logic.vil !== null;
  const liveGate = logic?.gates.find((g) => g.unit === gate.unit) ?? null;

  const A = (a: number) => formatResult(locale, a, 'ampere');
  const pins = pinViews({
    t,
    V,
    A,
    card,
    gate,
    liveGate,
    logic,
    failure,
    running,
    id: component.id,
  });

  // Truth table: every input combination of the device's function (the datasheet table).
  const n = gate.inputs.length;
  const combos = Array.from({ length: 1 << n }, (_, m) =>
    Array.from({ length: n }, (_, i) => ((m >> (n - 1 - i)) & 1) === 1),
  );
  const rowOf = (g: { inputs: LogicPinState[] }) =>
    g.inputs.every((p) => p.level === 'high' || p.level === 'low')
      ? g.inputs.map((p) => HL(p.level === 'high')).join('')
      : null;
  const gatesAt = (key: string) =>
    (logic?.gates ?? []).filter((g) => rowOf(g) === key).map((g) => g.unit || '●');
  const selectedRow = liveGate ? rowOf(liveGate) : null;
  const letters = gate.inputs.map((p) => pinName(p.replace(/\d$/, '')));
  const outLetter = pinName(gate.output.replace(/\d$/, ''));

  return (
    <section class="logic-state" data-testid="logic-state" aria-labelledby="logic-state-heading">
      <h3 id="logic-state-heading">{t('logic.inspect.title')}</h3>
      <p class="muted small" data-testid="logic-thresholds">
        {logic && rowKnown
          ? t('logic.inspect.thresholds', {
              supply: isolateLtr(`V_CC = ${V(logic.supplyV)}`),
              vih: isolateLtr(`V_IH = ${V(logic.vih)}`),
              vil: isolateLtr(`V_IL = ${V(logic.vil)}`),
              part: isolateLtr(logic.partNumber),
            })
          : logic
            ? t('logic.inspect.noRow', { part: isolateLtr(card.partNumber) })
            : t('logic.inspect.idle', { part: isolateLtr(card.partNumber) })}
      </p>
      {!logic && <ThresholdRows card={card} locale={locale} />}
      {gates.length > 1 && (
        <div class="logic-gate-select" role="group" aria-label={t('logic.inspect.gates')}>
          {gates.map((g, i) => {
            const live = logic?.gates.find((x) => x.unit === g.unit);
            const summary = live
              ? `${live.inputs.map((p) => levelLetter(p.level)).join('·')}→${levelLetter(live.output.level)}`
              : '';
            return (
              <button
                key={g.unit}
                type="button"
                class="logic-gate-button small"
                data-testid={`logic-gate-${g.unit}`}
                aria-pressed={i === gi ? 'true' : 'false'}
                onClick={() => setSel(i)}
              >
                {t('logic.inspect.gateN', { n: isolateLtr(g.unit) })}
                {summary && (
                  <span class="technical logic-gate-summary" dir="ltr">
                    {summary}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      <table class="logic-pins" data-testid="logic-pins">
        <thead>
          <tr>
            <th scope="col">{t('logic.inspect.pin')}</th>
            <th scope="col">{t('logic.inspect.level')}</th>
            <th scope="col">{t('logic.inspect.voltage')}</th>
          </tr>
        </thead>
        <tbody>
          {pins.flatMap((p) => [
            <tr
              key={p.pin}
              data-testid={`logic-pin-${p.pin}`}
              data-level={p.state}
              class={`logic-level-${p.state}`}
            >
              <td class="technical" dir="ltr">
                {pinName(p.pin)}
              </td>
              <td data-testid={`logic-level-${p.pin}`}>{t(levelKey(p.state))}</td>
              <td class="technical" dir="ltr" data-testid={`logic-volts-${p.pin}`}>
                {V(p.volts)}
              </td>
            </tr>,
            <tr key={`${p.pin}-why`} class="logic-why">
              <td colSpan={3} class="small muted" data-testid={`logic-why-${p.pin}`}>
                {p.why}
              </td>
            </tr>,
          ])}
        </tbody>
      </table>
      <InputControls
        doc={doc}
        component={component}
        inputs={gate.inputs}
        running={running}
        pressed={pressed}
        readOnly={!!readOnly}
      />
      <h4>{t('logic.inspect.truthTable', { fn: isolateLtr(fn) })}</h4>
      <table class="logic-truth" data-testid="logic-truth" dir="ltr">
        <thead>
          <tr>
            {letters.map((l) => (
              <th key={l} scope="col" class="technical">
                {l}
              </th>
            ))}
            <th scope="col" class="technical">
              {outLetter}
            </th>
            {gates.length > 1 && (
              <th scope="col" dir="auto">
                {t('logic.inspect.gatesHere')}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {combos.map((combo) => {
            const key = combo.map(HL).join('');
            const here = gatesAt(key);
            const active = key === selectedRow;
            return (
              <tr
                key={key}
                data-testid={`logic-truth-${key}`}
                class={active ? 'active' : here.length ? 'occupied' : undefined}
                aria-current={active ? 'true' : undefined}
              >
                {combo.map((b, i) => (
                  <td key={i} class="technical">
                    {HL(b)}
                  </td>
                ))}
                <td class="technical">{HL(evaluate(card.function, combo))}</td>
                {gates.length > 1 && (
                  <td class="technical" data-testid={`logic-truth-gates-${key}`}>
                    {here.join(', ')}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p class="muted small">{running ? t('logic.inspect.note') : t('logic.inspect.noteIdle')}</p>
    </section>
  );
}

const levelLetter = (l: string) =>
  l === 'high' ? 'H' : l === 'low' ? 'L' : l === 'off' ? '–' : '?';

function levelKey(state: PinView['state']): MessageKey {
  return `logic.inspect.level.${state === 'out_of_range' ? 'outOfRange' : state === 'not_simulated' ? 'notSimulated' : state}` as MessageKey;
}

/** The datasheet's input rows (V_CC range → V_IH / V_IL), shown before a run. */
function ThresholdRows({ card, locale }: { card: LogicCard; locale: LocaleInfo }) {
  const t = useT();
  const v = (x: number) => formatResult(locale, x, 'volt');
  const th = (x: { v: number } | { k: number }) =>
    'v' in x ? v(x.v) : `${formatNumber(locale, x.k)} × V_CC`;
  return (
    <table class="logic-rows small" data-testid="logic-rows">
      <thead>
        <tr>
          {['V_CC', 'V_IH', 'V_IL'].map((h) => (
            // Datasheet symbols: technical tokens, the same in every locale.
            <th key={h} scope="col" class="technical" dir="ltr">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {card.inputRows.map((r) => (
          <tr key={`${r.vcc[0]}-${r.vcc[1]}`}>
            <td class="technical" dir="ltr">
              {`${v(r.vcc[0])} – ${v(r.vcc[1])}`}
            </td>
            <td class="technical" dir="ltr">
              {`≥ ${th(r.vih)}`}
            </td>
            <td class="technical" dir="ltr">
              {`≤ ${th(r.vil)}`}
            </td>
          </tr>
        ))}
      </tbody>
      <caption class="muted small">{t('logic.inspect.rowsCaption')}</caption>
    </table>
  );
}

/** The per-pin views of one gate: the live result, else the refusal, else idle. */
function pinViews({
  t,
  V,
  card,
  gate,
  liveGate,
  logic,
  failure,
  running,
  id,
  A,
}: {
  id: string;
  A: (a: number) => string;
  t: (k: MessageKey, p?: Record<string, string>) => string;
  V: (v: number | null | undefined) => string;
  card: LogicCard;
  gate: GateSpec;
  liveGate: LogicInspection['gates'][number] | null;
  logic: LogicInspection | null;
  failure: EngineError | null;
  running: boolean;
}): PinView[] {
  const all = [...gate.inputs.map((p) => [p, true] as const), [gate.output, false] as const];
  const L = (s: string) => isolateLtr(s);
  if (liveGate && logic) {
    const vcc = L(`V_CC = ${V(logic.supplyV)}`);
    const ins = liveGate.inputs.map((p) => levelLetter(p.level)).join('·');
    return all.map(([pin, input]) => {
      const p = input ? liveGate.inputs.find((x) => x.pin === pin)! : liveGate.output;
      let why: string;
      if (p.level === 'off') why = t(input ? 'logic.why.offInput' : 'logic.why.off');
      else if (input && p.level === 'high')
        why = t('logic.why.inHigh', { cmp: L(`${V(p.volts)} ≥ V_IH ${V(logic.vih)}`), vcc });
      else if (input && p.level === 'low')
        why = t('logic.why.inLow', { cmp: L(`${V(p.volts)} ≤ V_IL ${V(logic.vil)}`), vcc });
      else if (!input && (p.level === 'high' || p.level === 'low'))
        why = t('logic.why.out', {
          fn: L(card.function.toUpperCase()),
          ins: L(ins),
          out: L(levelLetter(p.level)),
        });
      else why = t('logic.why.unknown');
      const state: PinView['state'] =
        p.level === 'high' || p.level === 'low' || p.level === 'off' ? p.level : 'unknown';
      return { pin, input, state, volts: p.volts, why };
    });
  }
  if (failure && !(failure.components ?? []).includes(id))
    // Refused because of another part: nothing here was solved.
    return all.map(([pin, input]) => ({
      pin,
      input,
      state: 'not_simulated' as const,
      volts: null,
      why: t('logic.why.refusedElsewhere'),
    }));
  if (failure) {
    const d = (failure.detail ?? {}) as {
      value?: number;
      vcc?: number;
      vih?: number;
      vil?: number;
      limit?: number;
      pads?: number[];
    };
    return all.map(([pin, input]) => {
      if (failure.param !== pin)
        return {
          pin,
          input,
          state: 'not_simulated' as const,
          volts: null,
          // Review round 4: the part's own supply pin is undetermined: say so on every pin.
          why:
            failure.code === 'logic_supply_undriven'
              ? t('logic.why.supplyUndriven', { pin: L(datasheetPinName(failure.param ?? '')) })
              : t('logic.why.refusedElsewhere'),
        };
      const v = L(V(d.value));
      const vcc = L(`V_CC = ${V(d.vcc)}`);
      switch (failure.code) {
        case 'logic_input_undefined':
          return {
            pin,
            input,
            state: 'undefined' as const,
            volts: d.value ?? null,
            why: t('logic.why.undefined', {
              v,
              vil: L(`V_IL ${V(d.vil)}`),
              vih: L(`V_IH ${V(d.vih)}`),
              vcc,
            }),
          };
        case 'logic_input_floating':
          return {
            pin,
            input,
            state: 'floating' as const,
            volts: null,
            why: d.pads?.length
              ? t(
                  (d.pads ?? []).length > 1
                    ? 'logic.why.floatingPadsMany'
                    : 'logic.why.floatingPads',
                  {
                    pads: L((d.pads ?? []).map((g) => `GPIO${g}`).join(', ')),
                  },
                )
              : t('logic.why.floating'),
          };
        case 'logic_input_out_of_range':
          return {
            pin,
            input,
            state: 'out_of_range' as const,
            volts: d.value ?? null,
            why: t('logic.why.outOfRange', { v }),
          };
        case 'logic_unknown_state':
          return {
            pin,
            input,
            state: 'unknown' as const,
            volts: null,
            why: t('logic.why.unknown'),
          };
        case 'logic_output_uncharacterized':
          return {
            pin,
            input,
            state: 'unsupported' as const,
            volts: null,
            why: t('logic.why.outputUncharacterized', {
              limit: L(d.limit === undefined ? '—' : A(d.limit)),
              vcc,
            }),
          };
        default:
          return {
            pin,
            input,
            state: 'not_simulated' as const,
            volts: null,
            why: t('logic.why.refusedElsewhere'),
          };
      }
    });
  }
  return all.map(([pin, input]) => ({
    pin,
    input,
    state: 'idle' as const,
    volts: null,
    why: running ? t('logic.why.waiting') : t('logic.why.idle'),
  }));
}

/**
 * The inputs the user can operate from the panel: a toggle switch or push button on an input's
 * net (the same actions as clicking the part in a view), and the ESP32 GPIOs that drive an input.
 */
function InputControls({
  doc,
  component,
  inputs,
  running,
  pressed,
  readOnly,
}: {
  doc: ProjectDocument;
  component: ComponentInstance;
  inputs: string[];
  running: boolean;
  pressed: readonly string[];
  readOnly: boolean;
}) {
  const t = useT();
  const store = useStore();
  type Row = { pin: string; kind: 'mcu' | 'toggle' | 'momentary'; id: string; gpio: number };
  const seen = new Set<string>();
  const rows = inputs.flatMap((pin): Row[] => {
    const net = doc.connections.find(
      (c) => c.component === component.id && c.terminal === pin,
    )?.net;
    if (!net) return [];
    const on = doc.connections.filter((c) => c.net === net && c.component !== component.id);
    // An input tied to a supply rail or GND cannot be changed by a switch on that rail (the
    // switch changes another net): no control is offered for it (review round 2).
    const railed =
      doc.nets.find((n) => n.id === net)?.role === 'ground' ||
      on.some(
        (c) => doc.components.find((x) => x.id === c.component)?.type === 'instrument.lab_psu',
      );
    if (railed) return [];
    return on.flatMap((c): Row[] => {
      // One control per part, under the first input it reaches.
      // (A board appears once per GPIO: its pins are separate sources.)
      const key = /^gpio\d+$/.test(c.terminal) ? `${c.component}.${c.terminal}` : c.component;
      if (seen.has(key)) return [];
      seen.add(key);
      const other = doc.components.find((x) => x.id === c.component);
      if (!other) return [];
      if (other.type === 'board.esp32_devkitc_wroom32' && /^gpio\d+$/.test(c.terminal))
        return [{ pin, kind: 'mcu', id: other.id, gpio: Number(c.terminal.slice(4)) }];
      const kind = controlKind(other.type);
      return kind ? [{ pin, kind, id: other.id, gpio: -1 }] : [];
    });
  });
  if (!rows.length) return null;
  return (
    <div class="logic-controls" data-testid="logic-controls">
      <h4>{t('logic.controls.heading')}</h4>
      <ul class="small">
        {rows.map((r) => {
          const pinText = isolateLtr(datasheetPinName(r.pin));
          if (r.kind === 'mcu')
            return (
              <li key={`${r.pin}-${r.id}`} data-testid={`logic-mcu-${r.pin}`}>
                {t('logic.controls.mcu', { pin: pinText, gpio: isolateLtr(`GPIO${r.gpio}`) })}
              </li>
            );
          const c = doc.components.find((x) => x.id === r.id)!;
          if (r.kind === 'toggle') {
            const key = CATALOG[c.type].toggleParam!;
            const closed = c.params[key] === true;
            return (
              <li key={`${r.pin}-${r.id}`}>
                <button
                  type="button"
                  class="button small"
                  data-testid={`logic-control-${r.id}`}
                  aria-pressed={closed ? 'true' : 'false'}
                  disabled={readOnly}
                  onClick={() => toggleControl(store, doc, r.id)}
                >
                  {t(closed ? 'logic.controls.toggleClosed' : 'logic.controls.toggleOpen', {
                    id: isolateLtr(r.id),
                    pin: pinText,
                  })}
                </button>
              </li>
            );
          }
          const held = pressed.includes(r.id);
          const press = (v: boolean) => running && pressControl(store, r.id, v);
          return (
            <li key={`${r.pin}-${r.id}`}>
              <button
                type="button"
                class="button small"
                data-testid={`logic-control-${r.id}`}
                aria-pressed={held ? 'true' : 'false'}
                disabled={!running || readOnly}
                onPointerDown={() => press(true)}
                onPointerUp={() => press(false)}
                onPointerLeave={() => held && press(false)}
                onKeyDown={(e) => {
                  if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) press(true);
                }}
                onKeyUp={(e) => {
                  if (e.key === ' ' || e.key === 'Enter') press(false);
                }}
              >
                {t('logic.controls.hold', { id: isolateLtr(r.id), pin: pinText })}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

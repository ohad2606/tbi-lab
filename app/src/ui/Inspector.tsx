import { useEffect, useRef, useState } from 'preact/hooks';
import {
  CATALOG,
  deleteSelection,
  emptySelection,
  parseQuantity,
  setParam,
  setWireColor,
  WIRE_COLORS,
  type Wire,
  type WireColor,
  type CheckIssue,
  type ComponentInstance,
  type ParamDef,
  type UnitId,
} from '@tbi-lab/domain';
import {
  catalogText,
  formatNumber,
  formatQuantity,
  inputForm,
  isMessageKey,
  isolateLtr,
  unitSymbol,
} from '../i18n/i18n.js';
import type { ComponentResult, SolveSuccess } from '@tbi-lab/engine';
import { formatPower, formatResult } from '../sim/format.js';
import { RatingGroup } from './NoticeBar.js';
import { warningsFor } from '../sim/ratings.js';
import { useAppState, useStore, useT } from './context.js';
import { checksFor } from './checks.js';
import { NEUTRAL_HEX, resolveWireColors } from '../views/wireColors.js';
import { rotateRouted } from './routing.js';
import { probeTargetName, readProbe, type Probe } from './probes.js';
import { McuPanel } from './McuPanel.js';

interface InspectorProps {
  probes: Probe[];
  onRemoveProbe(id: string): void;
  onClearProbes(): void;
}

/**
 * A wire's colour: Auto (from its net, shown with the colour it gives) or one of the palette
 * colours. The same resolution colours the wire in the Circuit and 3D views (wireColors.ts).
 */
function WireColorField({ wire, readOnly }: { wire: Wire; readOnly: boolean }) {
  const { doc } = useAppState();
  const store = useStore();
  const t = useT();
  if (!doc) return null;
  const resolved = resolveWireColors(doc).get(wire.id);
  const name = (c: WireColor) => t(`wireColor.${c}`);
  return (
    <>
      <dt>
        <label for="wire-color">{t('inspector.wireColor')}</label>
      </dt>
      <dd class="wire-color-field">
        <span
          class="wire-swatch"
          aria-hidden="true"
          style={{ background: resolved?.hex ?? NEUTRAL_HEX }}
        />
        <select
          id="wire-color"
          data-testid="wire-color"
          value={wire.color ?? 'auto'}
          disabled={readOnly}
          onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            store.apply(setWireColor(doc, wire.id, v === 'auto' ? null : (v as WireColor)));
          }}
        >
          <option value="auto">
            {resolved?.auto
              ? t('wireColor.autoIs', { color: name(resolved.auto) })
              : t('wireColor.auto')}
          </option>
          {WIRE_COLORS.map((c) => (
            <option key={c} value={c}>
              {name(c)}
            </option>
          ))}
        </select>
      </dd>
    </>
  );
}

export function Inspector({ probes, onRemoveProbe, onClearProbes }: InspectorProps) {
  const { doc, selection, readOnly, sim } = useAppState();
  const simActive = sim.status === 'running' || sim.status === 'starting';
  const outcome = sim.status === 'running' && sim.outcome.ok ? sim.outcome : null;
  const store = useStore();
  const t = useT();
  if (!doc) return null;
  const count = selection.components.length + selection.wires.length + selection.junctions.length;
  const single =
    count === 1 && selection.components.length === 1
      ? doc.components.find((c) => c.id === selection.components[0])
      : undefined;
  const wire =
    count === 1 && selection.wires.length === 1
      ? doc.layout.wires.find((w) => w.id === selection.wires[0])
      : undefined;
  const junction =
    count === 1 && selection.junctions.length === 1 ? selection.junctions[0] : undefined;

  const actions = !readOnly && count > 0 && (
    <div class="inspector-actions">
      {selection.components.length > 0 && (
        <button
          type="button"
          class="button"
          onClick={() => store.apply(rotateRouted(doc, selection.components))}
        >
          {t('inspector.rotate')}
        </button>
      )}
      <button
        type="button"
        class="button button-danger"
        data-testid="inspector-delete"
        disabled={simActive}
        onClick={() => store.apply(deleteSelection(doc, selection), emptySelection())}
      >
        {t('inspector.delete')}
      </button>
    </div>
  );

  const netOfWire = () => {
    if (!wire) return undefined;
    const end = [wire.from, wire.to].find((e) => e.kind === 'terminal');
    return end && end.kind === 'terminal'
      ? doc.connections.find((c) => c.component === end.component && c.terminal === end.terminal)
          ?.net
      : undefined;
  };

  return (
    <aside class="inspector" aria-labelledby="inspector-heading" data-testid="inspector">
      <h2 id="inspector-heading">{t('inspector.heading')}</h2>
      {count === 0 && <p class="muted">{t('inspector.empty')}</p>}
      {count > 1 && <p>{t('inspector.multi', { count })}</p>}
      {single?.type === 'instrument.lab_psu' ? (
        <PsuPanel component={single} readOnly={!!readOnly} />
      ) : (
        single && <ComponentProperties component={single} readOnly={!!readOnly} />
      )}
      {single && single.type !== 'instrument.lab_psu' && outcome && (
        <ComponentResultView outcome={outcome} component={single} />
      )}
      {wire && (
        <dl class="props">
          <dt>{t('inspector.type')}</dt>
          <dd>{t('inspector.wire')}</dd>
          <WireColorField wire={wire} readOnly={!!readOnly} />
          {netOfWire() && (
            <>
              <dt>{t('inspector.net')}</dt>
              <dd class="technical" dir="ltr">
                {netOfWire()}
              </dd>
            </>
          )}
        </dl>
      )}
      {wire && outcome && <NetResultView outcome={outcome} net={netOfWire()} />}
      {junction && (
        <dl class="props">
          <dt>{t('inspector.type')}</dt>
          <dd>{t('inspector.junction')}</dd>
        </dl>
      )}
      {actions}
      <ProbesSection probes={probes} onRemove={onRemoveProbe} onClear={onClearProbes} />
      {/* Kept mounted while running (hidden), so Run/Stop never re-renders the list. */}
      <ChecksSection hidden={simActive} />
      <details class="shortcuts">
        <summary>{t('inspector.shortcutsHeading')}</summary>
        <p class="muted small">{t('inspector.shortcuts')}</p>
      </details>
    </aside>
  );
}

function ComponentProperties({
  component: c,
  readOnly,
}: {
  component: ComponentInstance;
  readOnly: boolean;
}) {
  const { locale } = useAppState();
  const t = useT();
  const def = CATALOG[c.type];
  return (
    <>
      <dl class="props">
        <dt>{t('inspector.reference')}</dt>
        <dd class="technical" dir="ltr" data-testid="inspector-ref">
          {c.id}
        </dd>
        <dt>{t('inspector.type')}</dt>
        <dd>{catalogText(locale, def.nameKey)}</dd>
      </dl>
      {/* The board's firmware choice is not a normal-user picker (D-S7-5): the ESP32 panel shows
          what the board runs; the Advanced prebuilt path is there too. */}
      {def.params
        .filter((p) => !(c.type === 'board.esp32_devkitc_wroom32' && p.key === 'firmware'))
        .filter((p) => !p.environment)
        .map((p) => (
          <ParamField key={`${c.id}.${p.key}`} component={c} def={p} readOnly={readOnly} />
        ))}
      {def.params.some((p) => p.environment) && (
        // Sprint 10: what the part senses is the SIMULATED ENVIRONMENT, not a part property. It
        // is a live control: changing it while running re-solves at once.
        <section class="environment" data-testid={`environment-${c.id}`}>
          <h3 class="environment-heading">{t('inspector.environment')}</h3>
          <p class="muted small">{t('inspector.environmentNote')}</p>
          {def.params
            .filter((p) => p.environment)
            .map((p) => (
              <ParamField key={`${c.id}.${p.key}`} component={c} def={p} readOnly={readOnly} />
            ))}
        </section>
      )}
      {c.type === 'board.esp32_devkitc_wroom32' && <McuPanel component={c} />}
      {c.type === 'component.push_button' && (
        <p class="muted small" data-testid="switch-hint">
          {t('switch.button.hint')}
        </p>
      )}
      {c.type === 'component.toggle_switch' && (
        <p class="muted small" data-testid="switch-hint">
          {t('switch.toggle.hint')}
        </p>
      )}
    </>
  );
}

function ParamField({
  component: c,
  def,
  readOnly,
}: {
  component: ComponentInstance;
  def: ParamDef;
  readOnly: boolean;
}) {
  const { doc, locale, sim } = useAppState();
  const store = useStore();
  const t = useT();
  const current = c.params[def.key];
  // While a simulation runs only live-capable parameters (PSU controls) may change; any other
  // value belongs to the loaded snapshot and needs a Stop first.
  const locked =
    (sim.status === 'running' || sim.status === 'starting' || sim.status === 'stopping') &&
    !def.live;
  const disabled = readOnly || locked;
  const lockedHint = locked && (
    <p class="muted small" data-testid={`param-${c.id}-${def.key}-locked`}>
      {t('inspector.stopToChange')}
    </p>
  );
  const id = `param-${c.id}-${def.key}`;

  const shown =
    def.kind === 'quantity' && current && typeof current === 'object'
      ? inputForm(current.value)
      : '';
  // The draft starts at the stored value, so the first render is complete by itself. The
  // effect below resets it ONLY when the stored value or component really changes: a passive
  // effect runs after paint, and on mount it would otherwise wipe text typed (and the error
  // it produced) in the meantime (CI run 35828605417).
  const [draft, setDraft] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  const synced = useRef({ shown, id: c.id });
  useEffect(() => {
    if (synced.current.shown === shown && synced.current.id === c.id) return;
    synced.current = { shown, id: c.id };
    setDraft(shown);
    setError(null);
  }, [shown, c.id]);

  if (def.kind === 'boolean') {
    return (
      <div class="field field-check">
        <input
          id={id}
          type="checkbox"
          data-testid={id}
          checked={current === true}
          disabled={disabled}
          onChange={(e) =>
            doc && store.apply(setParam(doc, c.id, def.key, (e.target as HTMLInputElement).checked))
          }
        />
        <label for={id}>{catalogText(locale, def.labelKey)}</label>
        {lockedHint}
      </div>
    );
  }

  if (def.kind === 'enum') {
    return (
      <div class="field">
        <label for={id}>{catalogText(locale, def.labelKey)}</label>
        <select
          id={id}
          data-testid={id}
          value={typeof current === 'string' ? current : def.default}
          disabled={disabled}
          onChange={(e) =>
            doc && store.apply(setParam(doc, c.id, def.key, (e.target as HTMLSelectElement).value))
          }
        >
          {def.options.map((o) => (
            <option key={o.value} value={o.value}>
              {catalogText(locale, o.labelKey)}
            </option>
          ))}
        </select>
        {lockedHint}
      </div>
    );
  }

  const range = {
    min: isolateLtr(formatQuantity(locale, { value: def.min, unit: def.unit })),
    max: isolateLtr(formatQuantity(locale, { value: def.max, unit: def.unit })),
  };
  /**
   * Commit exactly the text being committed, taken from the input element itself. The draft
   * state only drives rendering: a fast Enter or Blur can arrive before a pending state
   * render has run, so correctness must not depend on it (CI run 35789744836).
   */
  const commit = (raw: string) => {
    if (!doc || raw === shown) return setError(null);
    const parsed = parseQuantity(raw, def.unit);
    if (!parsed.ok) return setError(t(`error.parse.${parsed.error}`));
    if (parsed.value < def.min || parsed.value > def.max) return setError(t('error.range', range));
    setError(null);
    // Committing the value already stored (e.g. Enter then Blur) is not a new revision.
    if (typeof current === 'object' && current.value === parsed.value) return;
    store.apply(setParam(doc, c.id, def.key, { value: parsed.value, unit: def.unit }));
  };

  return (
    <div class="field">
      <label for={id}>{catalogText(locale, def.labelKey)}</label>
      <div class="field-row" dir="ltr">
        <input
          id={id}
          data-testid={id}
          class="technical"
          dir="ltr"
          inputMode="decimal"
          autocomplete="off"
          spellcheck={false}
          value={draft}
          disabled={disabled}
          aria-invalid={error ? 'true' : 'false'}
          aria-describedby={`${id}-hint`}
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
          onBlur={(e) => commit(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(e.currentTarget.value);
            if (e.key === 'Escape') {
              setDraft(shown);
              setError(null);
            }
          }}
        />
        <span class="unit">{unitSymbol(locale, def.unit)}</span>
      </div>
      {def.environment && (
        <input
          type="range"
          class="environment-slider"
          data-testid={`${id}-slider`}
          aria-label={catalogText(locale, def.labelKey)}
          min={0}
          max={SLIDER_STEPS}
          step={1}
          value={sliderPosition(def, typeof current === 'object' ? current.value : def.default)}
          disabled={disabled}
          onChange={(e) => {
            if (!doc) return;
            const value = sliderValue(def, Number((e.target as HTMLInputElement).value));
            if (typeof current === 'object' && current.value === value) return;
            store.apply(setParam(doc, c.id, def.key, { value, unit: def.unit }));
          }}
        />
      )}
      {error ? (
        <p class="field-error" role="alert" data-testid={`${id}-error`}>
          {error}
        </p>
      ) : (
        <p class="muted small" id={`${id}-hint`}>
          {t('inspector.range', range)}
        </p>
      )}
      {lockedHint}
    </div>
  );
}

/** Environment sliders: positions 0..SLIDER_STEPS over [min, max], linear or logarithmic. */
const SLIDER_STEPS = 1000;
type QuantityDef = Extract<ParamDef, { kind: 'quantity' }>;
function sliderPosition(def: QuantityDef, value: number): number {
  const f =
    def.environment?.scale === 'log'
      ? Math.log(value / def.min) / Math.log(def.max / def.min)
      : (value - def.min) / (def.max - def.min);
  return Math.round(Math.min(1, Math.max(0, f)) * SLIDER_STEPS);
}
function sliderValue(def: QuantityDef, position: number): number {
  const f = position / SLIDER_STEPS;
  const raw =
    def.environment?.scale === 'log'
      ? def.min * (def.max / def.min) ** f
      : def.min + f * (def.max - def.min);
  // Three significant digits: a slider sets a round value; the field accepts any exact one.
  return Math.min(def.max, Math.max(def.min, Number(raw.toPrecision(3))));
}

function ResultRow({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd class="technical" dir="ltr" data-testid={testId}>
        {value}
      </dd>
    </>
  );
}

/** Solved values for one component. Runtime only: visually and structurally apart from the
 *  editable, persisted properties above. */
function ComponentResultView({
  outcome,
  component,
}: {
  outcome: SolveSuccess;
  component: ComponentInstance;
}) {
  const { locale, doc } = useAppState();
  const t = useT();
  const r = outcome.components[component.id];
  const I = (v: number | null) =>
    v === null ? t('sim.results.undefined') : formatResult(locale, v, 'ampere');
  const V = (v: number | null) =>
    v === null ? t('sim.results.undefined') : formatResult(locale, v, 'volt');
  const def = CATALOG[component.type];
  return (
    <section class="sim-results" aria-labelledby="sim-results-heading" data-testid="sim-results">
      <h3 id="sim-results-heading">{t('sim.results.heading')}</h3>
      <p class="muted small">{t('sim.results.note')}</p>
      {!r ? (
        <p data-testid="sim-results-none">
          {component.type === 'component.ground' ? V(0) : t('sim.results.notSimulated')}
        </p>
      ) : (
        <dl class="props">
          {r.type === 'instrument.lab_psu' && (
            <>
              <ResultRow
                label={t('sim.results.mode')}
                value={t(`sim.mode.${r.mode ?? 'off'}`)}
                testId="result-mode"
              />
              <ResultRow
                label={t('sim.results.outputVoltage')}
                value={V(r.voltage)}
                testId="result-voltage"
              />
              <ResultRow
                label={t('sim.results.outputCurrent')}
                value={I(r.current)}
                testId="result-current"
              />
            </>
          )}
          {(r.type === 'component.led' || r.type === 'component.diode') && (
            <>
              <ResultRow
                label={t('sim.results.forwardVoltage')}
                value={V(r.voltage)}
                testId="result-voltage"
              />
              <ResultRow
                label={t('sim.results.forwardCurrent')}
                value={I(r.current)}
                testId="result-current"
              />
            </>
          )}
          {(r.type === 'component.push_button' || r.type === 'component.toggle_switch') && (
            <>
              <ResultRow
                label={t('sim.results.contact')}
                value={t(r.closed ? 'switch.state.closed' : 'switch.state.open')}
                testId="result-contact"
              />
              <ResultRow
                label={t('sim.results.current')}
                value={I(r.current)}
                testId="result-current"
              />
            </>
          )}
          {r.type === 'component.resistor' && (
            <>
              <ResultRow
                label={t('sim.results.current')}
                value={I(r.current)}
                testId="result-current"
              />
              <ResultRow
                label={t('sim.results.voltage')}
                value={V(r.voltage)}
                testId="result-voltage"
              />
            </>
          )}
          {!ORIGINAL_TYPES.has(r.type) && <PartResultRows result={r} />}
          {def.terminals.map((term) => (
            <ResultRow
              key={term.id}
              label={t('sim.results.potential', { terminal: catalogText(locale, term.labelKey) })}
              value={V(r.terminals[term.id] ?? null)}
              testId={`result-terminal-${term.id}`}
            />
          ))}
        </dl>
      )}
      {r &&
        (r.type === 'component.resistor' ||
          r.type === 'component.led' ||
          r.type === 'component.diode') &&
        r.voltage !== null &&
        r.current !== null && (
          <dl class="props">
            <ResultRow
              label={t('sim.results.power')}
              value={formatPower(locale, Math.abs(r.voltage * r.current))}
              testId="result-power"
            />
          </dl>
        )}
      {doc &&
        (() => {
          const rows = warningsFor(doc, outcome).filter((w) => w.component === component.id);
          return rows.length ? (
            <div class="sim-warning" data-testid="result-rating">
              <RatingGroup component={component.id} rows={rows} />
            </div>
          ) : null;
        })()}
      {r?.outsideModelRange && (
        <p class="sim-note" data-testid="result-outside-model">
          {t('sim.results.outsideModel')}
        </p>
      )}
      {r?.type === 'component.led' && <p class="muted small">{t('sim.results.ledLit')}</p>}
    </section>
  );
}

/** Units of numeric part states (language-neutral keys). */
const STATE_UNITS: Record<string, UnitId> = { resistance: 'ohm' };

/** The eight original types have dedicated rows above; parts added since are described by data. */
const ORIGINAL_TYPES = new Set<string>([
  'instrument.lab_psu',
  'component.ground',
  'component.resistor',
  'component.led',
  'component.diode',
  'component.push_button',
  'component.toggle_switch',
  'board.esp32_devkitc_wroom32',
]);

/**
 * Sprint 10 part results, generically: voltage and current where the part defines them, then its
 * named currents (`sim.part.current.<key>`: an RGB channel, a relay coil) and states
 * (`sim.part.state.<key>`, values `sim.part.state.<key>.<value>` or a boolean yes/no).
 */
function PartResultRows({ result: r }: { result: ComponentResult }) {
  const { locale } = useAppState();
  const t = useT();
  const I = (v: number | null) =>
    v === null ? t('sim.results.undefined') : formatResult(locale, v, 'ampere');
  const label = (key: string) => (isMessageKey(key) ? t(key) : key);
  return (
    <>
      {r.voltage !== null && (
        <ResultRow
          // A part may name its voltage (a transistor's is V_CE): `sim.part.voltage.<type>`.
          label={
            label(`sim.part.voltage.${r.type}`) === `sim.part.voltage.${r.type}`
              ? t('sim.results.voltage')
              : label(`sim.part.voltage.${r.type}`)
          }
          value={formatResult(locale, r.voltage, 'volt')}
          testId="result-voltage"
        />
      )}
      {r.current !== null && !r.currents && (
        <ResultRow label={t('sim.results.current')} value={I(r.current)} testId="result-current" />
      )}
      {Object.entries(r.currents ?? {}).map(([k, v]) => (
        <ResultRow
          key={`i-${k}`}
          label={label(`sim.part.current.${k}`)}
          value={I(v)}
          testId={`result-current-${k}`}
        />
      ))}
      {Object.entries(r.state ?? {}).map(([k, v]) => (
        <ResultRow
          key={`s-${k}`}
          label={label(`sim.part.state.${k}`)}
          value={
            typeof v === 'boolean'
              ? t(v ? 'sim.part.yes' : 'sim.part.no')
              : typeof v === 'number'
                ? STATE_UNITS[k]
                  ? formatResult(locale, v, STATE_UNITS[k])
                  : formatNumber(locale, v)
                : label(`sim.part.state.${k}.${v}`)
          }
          testId={`result-state-${k}`}
        />
      ))}
    </>
  );
}

function NetResultView({ outcome, net }: { outcome: SolveSuccess; net: string | undefined }) {
  const { locale } = useAppState();
  const t = useT();
  const v = net !== undefined ? outcome.netVoltages[net] : undefined;
  return (
    <section class="sim-results" data-testid="sim-results">
      <h3>{t('sim.results.heading')}</h3>
      <dl class="props">
        <ResultRow
          label={t('sim.results.netVoltage')}
          value={v === undefined ? t('sim.results.undefined') : formatResult(locale, v, 'volt')}
          testId="result-net-voltage"
        />
      </dl>
    </section>
  );
}

/**
 * The V1 laboratory power supply (single channel, DC). Editable SETTINGS (persistent project
 * values; live while running) are kept visually and structurally apart from the MEASURED
 * OUTPUT (runtime values from the engine). CV/CC/OFF is the solver's operating state.
 */
function PsuPanel({ component: c, readOnly }: { component: ComponentInstance; readOnly: boolean }) {
  const { locale, sim } = useAppState();
  const t = useT();
  const def = CATALOG[c.type];
  const outcome = sim.status === 'running' && sim.outcome.ok ? sim.outcome : null;
  const r = outcome?.components[c.id];
  const mode = r?.mode;
  const dash = t('probe.noValue');
  return (
    <section class="psu-panel" data-testid="psu-panel" aria-labelledby="psu-panel-title">
      <h3 id="psu-panel-title">
        {t('psu.panel.title')}{' '}
        <span class="technical" dir="ltr">
          {c.id}
        </span>
      </h3>
      <div class="psu-display" data-testid="psu-display" role="status" aria-live="polite">
        <div class="psu-display-heading">{t('psu.measured')}</div>
        <div class="psu-readouts" dir="ltr">
          <div class="psu-readout">
            <span class="psu-readout-label">{t('psu.voltage')}</span>
            <span class="psu-readout-value" data-testid="psu-measured-voltage">
              {r && r.voltage !== null ? formatResult(locale, r.voltage, 'volt') : dash}
            </span>
          </div>
          <div class="psu-readout">
            <span class="psu-readout-label">{t('psu.current')}</span>
            <span class="psu-readout-value" data-testid="psu-measured-current">
              {r && r.current !== null ? formatResult(locale, r.current, 'ampere') : dash}
            </span>
          </div>
        </div>
        <div
          class={`psu-mode psu-mode-${mode ?? 'none'}`}
          data-testid="psu-mode"
          data-mode={mode ?? 'none'}
        >
          <span class="psu-mode-badge" aria-hidden="true">
            {mode ? t(`sim.badge.${mode}`) : dash}
          </span>
          <span>{mode ? t(`sim.mode.${mode}`) : t('psu.notRunning')}</span>
        </div>
        {mode === 'cc' && <p class="small psu-cc-note">{t('psu.ccNote')}</p>}
      </div>
      <div class="psu-settings">
        <h4>{t('psu.settings')}</h4>
        {def.params.map((p) => (
          <ParamField key={`${c.id}.${p.key}`} component={c} def={p} readOnly={readOnly} />
        ))}
      </div>
    </section>
  );
}

function ProbesSection({
  probes,
  onRemove,
  onClear,
}: {
  probes: Probe[];
  onRemove(id: string): void;
  onClear(): void;
}) {
  const { doc, sim, locale } = useAppState();
  const t = useT();
  if (!doc) return null;
  const outcome = sim.status === 'running' && sim.outcome.ok ? sim.outcome : null;
  return (
    <section class="probes-section" aria-labelledby="probes-heading" data-testid="probes-section">
      <h3 id="probes-heading">{t('probes.heading')}</h3>
      {probes.length === 0 ? (
        <p class="muted small">{t('probes.empty')}</p>
      ) : (
        <>
          <ul class="probe-list">
            {probes.map((p) => {
              const reading = readProbe(p, doc, outcome);
              const value =
                reading.value === null
                  ? t('probe.noValue')
                  : formatResult(locale, reading.value, reading.quantity);
              const name = probeTargetName(p);
              return (
                <li key={p.id}>
                  <span class="technical" dir="ltr" data-testid={`probe-reading-${name}`}>
                    {t(p.kind === 'current' ? 'probe.currentLabel' : 'probe.voltageLabel', {
                      point: name,
                      value,
                    })}
                  </span>
                  <button
                    type="button"
                    class="link-button"
                    aria-label={t('probes.remove', { point: name })}
                    onClick={() => onRemove(p.id)}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
          <button type="button" class="link-button small" onClick={onClear}>
            {t('probes.clear')}
          </button>
          <p class="muted small">{t('probes.note')}</p>
        </>
      )}
    </section>
  );
}

/** Editor-time checks (domain `checkCircuit`): explanations only; they change nothing. */
function ChecksSection({ hidden }: { hidden: boolean }) {
  const { doc, locale } = useAppState();
  const t = useT();
  if (!doc) return null;
  const issues = checksFor(doc);
  const list = (ids: string[]) => isolateLtr(ids.join(', '));
  const termName = (component: string, term: string) => {
    const c = doc.components.find((x) => x.id === component);
    const def = c ? CATALOG[c.type].terminals.find((x) => x.id === term) : undefined;
    return def ? catalogText(locale, def.labelKey) : term;
  };
  const text = (i: CheckIssue): string => {
    const component = isolateLtr(i.components[0] ?? '');
    switch (i.code) {
      case 'partially_wired':
        return t('checks.partially_wired', {
          component,
          terminals: (i.terminals ?? []).map((x) => termName(i.components[0]!, x)).join(', '),
        });
      case 'wire_over_terminal':
        return t('checks.wire_over_terminal', {
          component,
          terminal: termName(i.components[0]!, i.terminals?.[0] ?? ''),
        });
      case 'terminals_touching':
        return t('checks.terminals_touching', {
          component,
          terminal: termName(i.components[0]!, i.terminals?.[0] ?? ''),
          other: isolateLtr(i.components[1] ?? ''),
          otherTerminal: termName(i.components[1]!, i.terminals?.[1] ?? ''),
        });
      case 'psu_shorted_by_wire':
        return t('checks.psu_shorted_by_wire', { component });
      case 'no_ground':
        return t('checks.no_ground');
      default:
        return t(`checks.${i.code}`, { components: list(i.components) });
    }
  };
  return (
    <section
      class="checks-section"
      aria-labelledby="checks-heading"
      data-testid="circuit-checks"
      hidden={hidden}
    >
      <h3 id="checks-heading">{t('checks.heading')}</h3>
      {issues.length === 0 ? (
        <p class="muted small">{t('checks.none')}</p>
      ) : (
        <ul class="check-list">
          {issues.map((i, n) => (
            <li
              key={n}
              class={`check check-${i.severity}`}
              data-code={i.code}
              data-testid={`check-${i.code}`}
            >
              <span class="check-icon" aria-hidden="true">
                {i.severity === 'warning' ? '!' : '•'}
              </span>
              <span>{text(i)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

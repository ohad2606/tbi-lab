import { Fragment } from 'preact';
import {
  CATALOG,
  MODEL_LIMITATIONS,
  deleteSelection,
  emptySelection,
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
  isMessageKey,
  isolateLtr,
  type LocaleInfo,
  type MessageKey,
} from '../i18n/i18n.js';
import type { ComponentResult, SolveSuccess } from '@tbi-lab/engine';
import { formatAngle, formatPower, formatPulseWidth, formatResult } from '../sim/format.js';
import { RatingGroup } from './NoticeBar.js';
import { warningsFor } from '../sim/ratings.js';
import { servosOnSupply } from '../sim/servoSupply.js';
import { useAppState, useStore, useT } from './context.js';
import { checksFor } from './checks.js';
import { NEUTRAL_HEX, resolveWireColors } from '../views/wireColors.js';
import { rotateRouted } from './routing.js';
import { probeTargetName, readProbe, type Probe } from './probes.js';
import { McuPanel } from './McuPanel.js';
import { ValueControl } from './ValueControl.js';

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
      {(MODEL_LIMITATIONS[c.type] ?? []).length > 0 && (
        // Sprint 13 H2: what this part's model does not simulate, or simulates under an assumption.
        <details class="model-limitations" data-testid={`limitations-${c.id}`}>
          <summary>{t('inspector.limitations')}</summary>
          <ul class="small">
            {MODEL_LIMITATIONS[c.type]!.map((id) => (
              <li key={id} data-testid={`limitation-${id}`}>
                {t(`limitation.${id}` as MessageKey)}
              </li>
            ))}
          </ul>
        </details>
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

  return (
    <>
      <ValueControl
        key={id}
        id={id}
        label={catalogText(locale, def.labelKey)}
        unit={def.unit}
        min={def.min}
        max={def.max}
        value={current && typeof current === 'object' ? current.value : null}
        disabled={disabled}
        {...(def.environment ? { slider: def.environment.scale ?? 'linear' } : {})}
        onCommit={(value, { slider }) => {
          if (!doc) return;
          if (typeof current === 'object' && current.value === value) return;
          // A slider drag (its live steps and its release) is one edit for undo.
          store.apply(
            setParam(doc, c.id, def.key, { value, unit: def.unit }),
            undefined,
            slider ? { coalesce: `slider:${id}` } : {},
          );
        }}
      />
      {lockedHint}
    </>
  );
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

/**
 * A current row. Under PWM (Sprint 15, R4: `ComponentResult.pwm`) the value is the time-average
 * over the waveform and says so, followed by the peak (what the ratings check).
 */
function CurrentRows({
  label,
  value,
  peak,
  pwm,
  testId,
}: {
  label: string;
  value: number | null;
  /** The peak over the PWM operating points; ignored unless `pwm`. */
  peak: number | null | undefined;
  pwm: boolean;
  testId: string;
}) {
  const { locale } = useAppState();
  const t = useT();
  const I = (v: number | null) =>
    v === null ? t('sim.results.undefined') : formatResult(locale, v, 'ampere');
  if (!pwm) return <ResultRow label={label} value={I(value)} testId={testId} />;
  return (
    <>
      <ResultRow label={t('sim.results.pwmAverage', { label })} value={I(value)} testId={testId} />
      <ResultRow
        label={t('sim.results.pwmPeak', { label })}
        value={I(peak ?? null)}
        testId={`${testId}-peak`}
      />
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
  const V = (v: number | null) =>
    v === null ? t('sim.results.undefined') : formatResult(locale, v, 'volt');
  const def = CATALOG[component.type];
  // Sprint 15 (R4): a part a PWM output switches reports time-averages (and its peak currents).
  const pwm = !!r?.pwm;
  const avgLabel = (label: string) => (pwm ? t('sim.results.pwmAverage', { label }) : label);
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
                label={avgLabel(t('sim.results.outputVoltage'))}
                value={V(r.voltage)}
                testId="result-voltage"
              />
              <CurrentRows
                label={t('sim.results.outputCurrent')}
                value={r.current}
                peak={r.pwm?.peakCurrent}
                pwm={pwm}
                testId="result-current"
              />
              <ServoCurrentNote psuId={component.id} />
            </>
          )}
          {(r.type === 'component.led' || r.type === 'component.diode') && (
            <>
              <ResultRow
                label={avgLabel(t('sim.results.forwardVoltage'))}
                value={V(r.voltage)}
                testId="result-voltage"
              />
              <CurrentRows
                label={t('sim.results.forwardCurrent')}
                value={r.current}
                peak={r.pwm?.peakCurrent}
                pwm={pwm}
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
              <CurrentRows
                label={t('sim.results.current')}
                value={r.current}
                peak={r.pwm?.peakCurrent}
                pwm={pwm}
                testId="result-current"
              />
            </>
          )}
          {r.type === 'component.resistor' && (
            <>
              <CurrentRows
                label={t('sim.results.current')}
                value={r.current}
                peak={r.pwm?.peakCurrent}
                pwm={pwm}
                testId="result-current"
              />
              <ResultRow
                label={avgLabel(t('sim.results.voltage'))}
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
              value={
                // Under PWM, |V_avg x I_avg| is not the average power: not shown as one.
                pwm
                  ? t('sim.results.pwmPower')
                  : formatPower(locale, Math.abs(r.voltage * r.current))
              }
              testId="result-power"
            />
          </dl>
        )}
      {pwm && (
        <p class="muted small" data-testid="result-pwm-note">
          {t('sim.results.pwmNote')}
        </p>
      )}
      {doc &&
        (() => {
          const rows = warningsFor(doc, outcome).filter((w) => w.component === component.id);
          const kinds = (['absolute', 'operating', 'unrated'] as const)
            .map((k) => rows.filter((w) => w.kind === k))
            .filter((g) => g.length);
          return kinds.length ? (
            <div class="sim-warning" data-testid="result-rating">
              {kinds.map((g) => (
                <RatingGroup key={g[0]!.kind} component={component.id} rows={g} />
              ))}
            </div>
          ) : null;
        })()}
      {r?.outsideModelRange && (
        <p class="sim-note" data-testid="result-outside-model">
          {
            // A part may word it for its own model (Sprint 15: the servo's supply range).
            t(
              isMessageKey(`sim.results.outsideModel.${r.type}`)
                ? (`sim.results.outsideModel.${r.type}` as MessageKey)
                : 'sim.results.outsideModel',
            )
          }
        </p>
      )}
      {r?.type === 'component.led' && <p class="muted small">{t('sim.results.ledLit')}</p>}
    </section>
  );
}

/** Part states that carry text the part displays (Sprint 12: the LCD's two lines). */
const TEXT_STATES: ReadonlySet<string> = new Set(['line1', 'line2']);

/** Units of numeric part states (language-neutral keys). */
const STATE_UNITS: Record<string, UnitId> = { resistance: 'ohm' };

/**
 * Numeric part states in units that are not stored engineering units (Sprint 15, the servo): its
 * shaft angles in degrees and its last accepted pulse width (reported in microseconds).
 */
const STATE_FORMATS: Record<string, (locale: LocaleInfo, v: number) => string> = {
  angleDeg: formatAngle,
  commandedDeg: formatAngle,
  pulseUs: formatPulseWidth,
};

/**
 * Named currents a part reports as unknown because they are NOT MODELLED (Sprint 15, decision
 * R4-D3: the servo's supply current): shown as such, never as 0 A or "not defined".
 */
const NOT_MODELLED_CURRENTS: Partial<Record<string, ReadonlySet<string>>> = {
  'component.servo_sg90': new Set(['supply']),
};

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
  const label = (key: string) => (isMessageKey(key) ? t(key) : key);
  const pwm = !!r.pwm;
  // A part may word a state for its own type (Sprint 12: an HC-SR04 is powered from 4.5 V, a
  // DHT22 from 3.3 V): `sim.part.state.<type>.<key>[.<value>]` before the shared wording.
  const stateText = (suffix: string) => {
    const own = `sim.part.state.${r.type}.${suffix}`;
    return label(isMessageKey(own) ? own : `sim.part.state.${suffix}`);
  };
  return (
    <>
      {r.voltage !== null && (
        <ResultRow
          // A part may name its voltage (a transistor's is V_CE): `sim.part.voltage.<type>`.
          label={((name: string) => (pwm ? t('sim.results.pwmAverage', { label: name }) : name))(
            label(`sim.part.voltage.${r.type}`) === `sim.part.voltage.${r.type}`
              ? t('sim.results.voltage')
              : label(`sim.part.voltage.${r.type}`),
          )}
          value={formatResult(locale, r.voltage, 'volt')}
          testId="result-voltage"
        />
      )}
      {r.current !== null && !r.currents && (
        <CurrentRows
          label={t('sim.results.current')}
          value={r.current}
          peak={r.pwm?.peakCurrent}
          pwm={pwm}
          testId="result-current"
        />
      )}
      {Object.entries(r.currents ?? {}).map(([k, v]) =>
        v === null && NOT_MODELLED_CURRENTS[r.type]?.has(k) ? (
          <ResultRow
            key={`i-${k}`}
            label={label(`sim.part.current.${k}`)}
            value={t('sim.results.notModelled')}
            testId={`result-current-${k}`}
          />
        ) : (
          <CurrentRows
            key={`i-${k}`}
            label={label(`sim.part.current.${k}`)}
            value={v}
            peak={r.pwm?.peakCurrents?.[k]}
            pwm={pwm}
            testId={`result-current-${k}`}
          />
        ),
      )}
      {Object.entries(r.state ?? {}).map(([k, v]) =>
        TEXT_STATES.has(k) && typeof v === 'string' ? (
          // Text the part itself shows (an LCD line, already mapped from its character ROM by
          // the engine): verbatim, never translated or mirrored, LTR and monospaced.
          <Fragment key={`s-${k}`}>
            <dt>{stateText(k)}</dt>
            <dd class="technical lcd-line" dir="ltr" data-testid={`result-state-${k}`}>
              {v}
            </dd>
          </Fragment>
        ) : (
          <ResultRow
            key={`s-${k}`}
            label={stateText(k)}
            value={
              typeof v === 'boolean'
                ? t(v ? 'sim.part.yes' : 'sim.part.no')
                : typeof v === 'number'
                  ? STATE_UNITS[k]
                    ? formatResult(locale, v, STATE_UNITS[k])
                    : STATE_FORMATS[k]
                      ? STATE_FORMATS[k](locale, v)
                      : formatNumber(locale, v)
                  : stateText(`${k}.${v}`)
            }
            testId={`result-state-${k}`}
          />
        ),
      )}
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
            {r?.pwm && (
              <span class="psu-readout-label" data-testid="psu-current-average">
                {t('psu.currentAverage')}
              </span>
            )}
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
        {r && <ServoCurrentNote psuId={c.id} />}
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

/** Sprint 17C: a supply's current leaves out the servos on its output (R4-D3); say so, by name. */
function ServoCurrentNote({ psuId }: { psuId: string }) {
  const { doc } = useAppState();
  const t = useT();
  const servos = servosOnSupply(doc, psuId);
  if (!servos.length) return null;
  return (
    <p class="small muted" data-testid="servo-current-excluded">
      {t('sim.results.servoCurrentExcluded', { components: isolateLtr(servos.join(', ')) })}
    </p>
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

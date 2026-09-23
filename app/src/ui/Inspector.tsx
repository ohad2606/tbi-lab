import { useEffect, useRef, useState } from 'preact/hooks';
import {
  CATALOG,
  deleteSelection,
  emptySelection,
  parseQuantity,
  rotateComponents,
  setParam,
  type ComponentInstance,
  type ParamDef,
} from '@tbi-lab/domain';
import { catalogText, formatQuantity, inputForm, isolateLtr, unitSymbol } from '../i18n/i18n.js';
import type { SolveSuccess } from '@tbi-lab/engine';
import { formatResult } from '../sim/format.js';
import { useAppState, useStore, useT } from './context.js';

export function Inspector() {
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
          onClick={() => store.apply(rotateComponents(doc, selection.components))}
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
      {single && <ComponentProperties component={single} readOnly={!!readOnly} />}
      {single && outcome && <ComponentResultView outcome={outcome} component={single} />}
      {wire && (
        <dl class="props">
          <dt>{t('inspector.type')}</dt>
          <dd>{t('inspector.wire')}</dd>
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
      <p class="muted small">{t('inspector.shortcuts')}</p>
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
      {def.params.map((p) => (
        <ParamField key={`${c.id}.${p.key}`} component={c} def={p} readOnly={readOnly} />
      ))}
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
  const locked = (sim.status === 'running' || sim.status === 'starting') && !def.live;
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
  const { locale } = useAppState();
  const t = useT();
  const r = outcome.components[component.id];
  const I = (v: number) => formatResult(locale, v, 'ampere');
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
          {r.type === 'component.led' && (
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
      {r?.outsideModelRange && (
        <p class="sim-note" data-testid="result-outside-model">
          {t('sim.results.outsideModel')}
        </p>
      )}
      {r?.type === 'component.led' && <p class="muted small">{t('sim.results.ledLit')}</p>}
    </section>
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

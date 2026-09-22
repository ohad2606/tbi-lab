import { useEffect, useState } from 'preact/hooks';
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
import { useAppState, useStore, useT } from './context.js';

export function Inspector() {
  const { doc, selection, readOnly } = useAppState();
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
  const { doc, locale } = useAppState();
  const store = useStore();
  const t = useT();
  const current = c.params[def.key];
  const id = `param-${c.id}-${def.key}`;

  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const shown =
    def.kind === 'quantity' && current && typeof current === 'object'
      ? inputForm(current.value)
      : '';
  useEffect(() => {
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
          disabled={readOnly}
          onChange={(e) =>
            doc && store.apply(setParam(doc, c.id, def.key, (e.target as HTMLInputElement).checked))
          }
        />
        <label for={id}>{catalogText(locale, def.labelKey)}</label>
      </div>
    );
  }

  const range = {
    min: isolateLtr(formatQuantity(locale, { value: def.min, unit: def.unit })),
    max: isolateLtr(formatQuantity(locale, { value: def.max, unit: def.unit })),
  };
  const commit = () => {
    if (!doc || draft === shown) return setError(null);
    const parsed = parseQuantity(draft, def.unit);
    if (!parsed.ok) return setError(t(`error.parse.${parsed.error}`));
    if (parsed.value < def.min || parsed.value > def.max) return setError(t('error.range', range));
    setError(null);
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
          disabled={readOnly}
          aria-invalid={error ? 'true' : 'false'}
          aria-describedby={`${id}-hint`}
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
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
    </div>
  );
}

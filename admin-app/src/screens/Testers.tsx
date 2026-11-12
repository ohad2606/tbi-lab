import { useEffect, useRef, useState } from 'preact/hooks';
import {
  DISPLAY_NAME_MAX,
  accountCounts,
  normalizeDisplayName,
  renameTester,
  setAccess,
  type AccountFilter,
  type AccountRow,
  type UsageMetric,
} from '@tbi-lab/admin-client';
import { BarChart, Confirm, Loading, Num, Problem, useWide } from '../common.js';
import { api, useConsole, useT } from '../context.js';
import {
  accountLabel,
  accountSeries,
  chartValue,
  daysEnding,
  israelDay,
  lastActivity,
  seriesTotals,
  simMinutes,
  testerList,
} from '../views.js';

const FILTERS: AccountFilter[] = ['active', 'disabled', 'all'];

function StatusBadge({ a }: { a: AccountRow }) {
  const t = useT();
  return (
    <span class={`badge badge-${a.status}`} data-testid="tester-status">
      {t(`admin.status.${a.status}`)}
    </span>
  );
}

/** Testers: cards on a phone, a table on a desktop; search, filter, sorted by last activity. */
export function Testers() {
  const t = useT();
  const { data, date, go } = useConsole();
  const wide = useWide();
  const [filter, setFilter] = useState<AccountFilter>('active');
  const [query, setQuery] = useState('');
  const { accounts, usage } = data;
  if (!accounts) return <Loading />;
  if (!accounts.ok)
    return <Problem error={accounts.error} unavailable="console.accounts.unavailable" />;
  const counts = accountCounts(accounts.value);
  const rows = testerList(accounts.value, usage?.ok ? usage.value : null, { filter, query });
  const open = (a: AccountRow) => (e: Event) => {
    e.preventDefault();
    go({ name: 'tester', target: a.target });
  };
  const last = (iso: string | null) =>
    iso ? date(iso) : <span class="muted">{t('console.testers.noActivity')}</span>;

  return (
    <section aria-labelledby="testers-h" class="stack">
      <h1 id="testers-h">{t('console.testers.heading')}</h1>
      <div class="toolbar">
        <label class="field">
          <span>{t('console.testers.search')}</span>
          <input
            type="search"
            dir="auto"
            autoComplete="off"
            spellcheck={false}
            data-testid="testers-search"
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
        </label>
        <div role="group" aria-label={t('admin.accounts.filter')} class="segmented">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              class="button"
              aria-pressed={filter === f}
              data-testid={`filter-${f}`}
              onClick={() => setFilter(f)}
            >
              {t(`admin.filter.${f}`)} <Num n={counts[f]} />
            </button>
          ))}
        </div>
      </div>
      <p class="muted small">
        {t('console.testers.sorted')} {t('admin.accounts.timeZone')}
      </p>
      {!rows.length ? (
        <p class="muted" data-testid="testers-none">
          {t('console.testers.none')}
        </p>
      ) : wide ? (
        <div class="table-wrap">
          <table data-testid="testers">
            <thead>
              <tr>
                <th scope="col">{t('admin.accounts.account')}</th>
                <th scope="col">{t('admin.accounts.status')}</th>
                <th scope="col">{t('console.testers.lastActivity')}</th>
                <th scope="col">{t('admin.accounts.signIns')}</th>
                <th scope="col">
                  <span class="visually-hidden">{t('admin.accounts.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ account: a, last: l }) => (
                <tr key={a.target} data-testid="tester-row" data-target={a.target}>
                  <td>
                    <div class="name" data-testid="tester-name">
                      {a.displayName ? <bdi dir="auto">{a.displayName}</bdi> : a.masked}
                    </div>
                    {a.displayName && (
                      <div class="muted small">
                        <bdi dir="ltr">{a.masked}</bdi>
                      </div>
                    )}
                  </td>
                  <td>
                    <StatusBadge a={a} />
                    {a.class === 'owner' && (
                      <span class="muted small"> {t('admin.class.owner')}</span>
                    )}
                  </td>
                  <td>{last(l)}</td>
                  <td>
                    <Num n={a.signIns} />
                  </td>
                  <td>
                    <a
                      class="button"
                      href={`#/testers/${a.target}`}
                      aria-label={t('console.testers.open.label', { account: accountLabel(a) })}
                      data-testid={`tester-open-${a.target}`}
                      onClick={open(a)}
                    >
                      {t('console.testers.open')}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ul class="list" data-testid="testers">
          {rows.map(({ account: a, last: l }) => (
            <li key={a.target} class="item" data-testid="tester-row" data-target={a.target}>
              <a
                class="item-link"
                href={`#/testers/${a.target}`}
                aria-label={t('console.testers.open.label', { account: accountLabel(a) })}
                data-testid={`tester-open-${a.target}`}
                onClick={open(a)}
              >
                <div class="item-head">
                  <strong class="name" data-testid="tester-name">
                    {a.displayName ? <bdi dir="auto">{a.displayName}</bdi> : a.masked}
                  </strong>
                  <StatusBadge a={a} />
                </div>
                {a.displayName && (
                  <div class="muted small">
                    <bdi dir="ltr">{a.masked}</bdi>
                  </div>
                )}
                <div class="small">
                  {t('console.testers.lastActivity')}: {last(l)}
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const CHART_METRICS: UsageMetric[] = ['runs', 'builds', 'simSeconds', 'signIns'];

type Pending = { kind: 'disable' | 'reactivate' } | { kind: 'rename' } | null;

/** One tester: account data, 30 days of usage, and the owner's actions on the record. */
export function TesterDetail({ target }: { target: string }) {
  const t = useT();
  const { data, date, go, settle } = useConsole();
  const [metric, setMetric] = useState<UsageMetric>('runs');
  const [action, setAction] = useState<Pending>(null);
  const [name, setName] = useState('');
  const [nameProblem, setNameProblem] = useState(false);
  const [busy, setBusy] = useState(false);
  const renameField = useRef<HTMLInputElement>(null);
  const renaming = action?.kind === 'rename';
  // The name field takes focus when the editor opens, not on every render (typing re-renders).
  useEffect(() => {
    if (renaming) renameField.current?.focus();
  }, [renaming]);
  const { accounts, usage } = data;
  const back = (
    <a
      href="#/testers"
      class="back"
      data-testid="tester-back"
      onClick={(e) => {
        e.preventDefault();
        go({ name: 'testers' });
      }}
    >
      {t('console.tester.back')}
    </a>
  );
  if (!accounts) return <Loading />;
  if (!accounts.ok)
    return <Problem error={accounts.error} unavailable="console.accounts.unavailable" />;
  const a = accounts.value.accounts.find((r) => r.target === target);
  if (!a)
    return (
      <section class="stack">
        {back}
        <p class="problem" role="alert" data-testid="tester-missing">
          {t('console.tester.notFound')}
        </p>
      </section>
    );
  const label = accountLabel(a);
  const full = a.displayName ? `${a.displayName} (${a.masked})` : a.masked;
  const days = daysEnding(israelDay(Date.now()), 30);
  const series = usage?.ok ? accountSeries(usage.value, a.target, days) : null;
  const totals = series ? seriesTotals(series) : null;

  const run = async (kind: 'disable' | 'reactivate') => {
    setBusy(true);
    try {
      await settle(await setAccess(api, kind, a.target), label, kind);
    } finally {
      setBusy(false);
      setAction(null);
    }
  };
  const saveName = async () => {
    const n = normalizeDisplayName(name);
    if (!n) {
      setNameProblem(true);
      return;
    }
    setBusy(true);
    try {
      const o = await renameTester(api, a.target, n);
      if (o.kind === 'refused' && o.error === 'invalid_name') {
        setNameProblem(true);
        return;
      }
      await settle(o, n, 'rename');
      setAction(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="tester-h" class="stack" data-testid="tester-detail">
      {back}
      <div class="item-head">
        <h1 id="tester-h" data-testid="tester-title">
          {a.displayName ? <bdi dir="auto">{a.displayName}</bdi> : t('admin.accounts.noName')}
        </h1>
        <StatusBadge a={a} />
      </div>
      <section class="card" aria-labelledby="tester-account-h">
        <h2 id="tester-account-h">{t('console.tester.details')}</h2>
        <dl class="facts">
          <div>
            <dt>{t('admin.accounts.account')}</dt>
            <dd>
              <bdi dir="ltr" data-testid="tester-masked">
                {a.masked}
              </bdi>
            </dd>
          </div>
          <div>
            <dt>{t('admin.accounts.class')}</dt>
            <dd>{t(`admin.class.${a.class}`)}</dd>
          </div>
          <div>
            <dt>{t('admin.accounts.added')}</dt>
            <dd>{a.dateAdded ? (date(`${a.dateAdded}T12:00:00Z`, false) ?? '—') : '—'}</dd>
          </div>
          <div>
            <dt>{t('admin.accounts.signIns')}</dt>
            <dd>
              <Num n={a.signIns} testid="tester-signins" />
            </dd>
          </div>
          <div>
            <dt>{t('admin.accounts.firstSignIn')}</dt>
            <dd>{date(a.firstSignIn) ?? t('admin.accounts.neverSignedIn')}</dd>
          </div>
          <div>
            <dt>{t('admin.accounts.lastSignIn')}</dt>
            <dd>{date(a.lastSignIn) ?? '—'}</dd>
          </div>
          <div>
            <dt>{t('console.tester.lastSeen')}</dt>
            <dd>{date(a.lastSeen) ?? '—'}</dd>
          </div>
          <div>
            <dt>{t('console.testers.lastActivity')}</dt>
            <dd>{date(lastActivity(a, usage?.ok ? usage.value : null)) ?? '—'}</dd>
          </div>
          {a.status === 'revoked' && (
            <div>
              <dt>{t('admin.accounts.disabledAt')}</dt>
              <dd>{date(a.statusUpdated) ?? '—'}</dd>
            </div>
          )}
          <div>
            <dt>{t('admin.accounts.googleId')}</dt>
            <dd>{a.googleIdRecorded ? t('admin.yes') : t('admin.no')}</dd>
          </div>
        </dl>
        <p class="muted small">{t('admin.accounts.timeZone')}</p>
      </section>

      <section class="card" aria-labelledby="tester-usage-h">
        <h2 id="tester-usage-h">{t('console.tester.usage')}</h2>
        {!usage ? (
          <Loading />
        ) : !usage.ok ? (
          <Problem
            error={usage.error}
            unavailable="console.usage.unavailable"
            testid="usage-problem"
          />
        ) : (
          <>
            <dl class="metrics" data-testid="tester-totals">
              {(['signIns', 'builds', 'prebuilt', 'runs', 'simSeconds', 'refusals'] as const).map(
                (m) => (
                  <div key={m} data-testid={`tester-metric-${m}`}>
                    <dt>{t(`console.metric.${m}`)}</dt>
                    <dd>
                      <Num n={m === 'simSeconds' ? simMinutes(totals![m]) : totals![m]} />
                    </dd>
                  </div>
                ),
              )}
            </dl>
            <div role="group" aria-label={t('console.tester.chart.metric')} class="segmented">
              {CHART_METRICS.map((m) => (
                <button
                  key={m}
                  type="button"
                  class="button"
                  aria-pressed={metric === m}
                  data-testid={`chart-metric-${m}`}
                  onClick={() => setMetric(m)}
                >
                  {t(`console.metric.${m}`)}
                </button>
              ))}
            </div>
            <BarChart
              values={series!.map((d) => chartValue(d.metrics, metric))}
              dates={days}
              label={t('console.tester.chart.label', {
                metric: t(`console.metric.${metric}`),
                total: chartValue(totals!, metric),
              })}
            />
          </>
        )}
      </section>

      <section class="card" aria-labelledby="tester-actions-h">
        <h2 id="tester-actions-h">{t('admin.accounts.actions')}</h2>
        {action?.kind === 'rename' ? (
          <form
            class="stack"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy) void saveName();
            }}
          >
            <label class="field">
              <span>{t('admin.rename.fieldLabel', { account: a.masked })}</span>
              <input
                type="text"
                dir="auto"
                autoComplete="off"
                maxLength={4 * DISPLAY_NAME_MAX}
                data-testid="rename-input"
                value={name}
                aria-invalid={nameProblem}
                ref={renameField}
                onInput={(e) => {
                  setName((e.target as HTMLInputElement).value);
                  setNameProblem(false);
                }}
              />
            </label>
            {nameProblem && (
              <p class="problem" data-testid="rename-problem">
                {t('admin.name.invalid', { max: DISPLAY_NAME_MAX })}
              </p>
            )}
            <div class="actions">
              <button type="button" class="button" onClick={() => setAction(null)}>
                {t('admin.rename.cancel')}
              </button>
              <button
                type="submit"
                class="button button-primary"
                data-testid="rename-save"
                aria-disabled={busy ? 'true' : undefined}
              >
                {busy ? t('admin.rename.saving') : t('admin.rename.save')}
              </button>
            </div>
          </form>
        ) : action ? (
          <Confirm
            title={t(`admin.confirm.title.${action.kind}`)}
            action={t(`admin.${action.kind}.confirm.action`)}
            danger={action.kind === 'disable'}
            busy={busy}
            onCancel={() => setAction(null)}
            onConfirm={() => void run(action.kind)}
          >
            {action.kind === 'disable' ? (
              <>
                <p>{t('admin.disable.confirm.what', { account: full })}</p>
                <ul>
                  <li>{t('admin.disable.confirm.signIn')}</li>
                  <li>{t('admin.disable.confirm.requests')}</li>
                  <li>{t('admin.disable.confirm.sessions')}</li>
                </ul>
                <p>{t('admin.disable.confirm.kept')}</p>
              </>
            ) : (
              <>
                <p>{t('admin.reactivate.confirm.what', { account: full })}</p>
                <p>{t('admin.reactivate.confirm.cap', { cap: accounts.value.cap })}</p>
              </>
            )}
          </Confirm>
        ) : (
          <div class="actions">
            <button
              type="button"
              class="button"
              data-testid="tester-rename"
              onClick={() => {
                setName(a.displayName ?? '');
                setNameProblem(false);
                setAction({ kind: 'rename' });
              }}
            >
              {t('admin.rename')}
            </button>
            {a.class !== 'owner' &&
              (a.status === 'revoked' ? (
                <button
                  type="button"
                  class="button button-primary"
                  data-testid="tester-reactivate"
                  onClick={() => setAction({ kind: 'reactivate' })}
                >
                  {t('admin.reactivate')}
                </button>
              ) : (
                <button
                  type="button"
                  class="button button-danger"
                  data-testid="tester-disable"
                  onClick={() => setAction({ kind: 'disable' })}
                >
                  {t('admin.disable')}
                </button>
              ))}
          </div>
        )}
      </section>
    </section>
  );
}

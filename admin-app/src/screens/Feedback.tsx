import { useEffect, useState } from 'preact/hooks';
import {
  deleteReport,
  deleteTesterReports,
  loadReport,
  testerLabel,
  type Loaded,
  type ReportDetail,
} from '@tbi-lab/admin-client';
import { Confirm, Loading, Num, Problem } from '../common.js';
import { api, useConsole, useT } from '../context.js';
import { codeKey } from '../i18n.js';
import { reportsNewestFirst } from '../views.js';

/** A report's kind and area in words; one this app does not know gets a generic label. */
const kindKey = (kind: string) => codeKey('report.kind.', kind, 'console.feedback.kind.other').key;
const categoryKey = (category: string) =>
  codeKey('report.category.', category, 'console.feedback.category.other').key;

/** The feedback list, newest first; "new" is per device (not opened here yet). */
export function Feedback() {
  const t = useT();
  const { data, date, seen, go } = useConsole();
  const { reports } = data;
  if (!reports) return <Loading />;
  return (
    <section aria-labelledby="feedback-h" class="stack">
      <h1 id="feedback-h">{t('console.feedback.heading')}</h1>
      {!reports.ok ? (
        <Problem error={reports.error} unavailable="console.reports.unavailable" />
      ) : !reports.value.length ? (
        <p class="muted" data-testid="feedback-empty">
          {t('admin.reports.empty')}
        </p>
      ) : (
        <>
          <ul class="list" data-testid="feedback-list">
            {reportsNewestFirst(reports.value).map((r) => (
              <li key={r.id} class="item" data-testid="report-row" data-id={r.id}>
                <a
                  class="item-link"
                  href={`#/feedback/${r.id}`}
                  aria-label={t('admin.reports.open.label', { id: r.id })}
                  data-testid={`report-open-${r.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    go({ name: 'report', id: r.id });
                  }}
                >
                  <div class="item-head">
                    <strong>{r.kind ? t(kindKey(r.kind)) : t('admin.reports.unreadable')}</strong>
                    {!seen.has(r.id) && (
                      <span class="badge badge-new" data-testid="report-new">
                        {t('console.feedback.new')}
                      </span>
                    )}
                  </div>
                  <div class="small">
                    {r.category ? t(categoryKey(r.category)) : null}
                    {r.blocking ? ` · ${t('admin.reports.blocking')}` : ''}
                  </div>
                  <div class="muted small">
                    {date(r.receivedAt) ?? '—'} · <bdi dir="ltr">{testerLabel(r.principal)}</bdi> ·{' '}
                    {t('admin.reports.length')} <Num n={r.length} />
                  </div>
                </a>
              </li>
            ))}
          </ul>
          <p class="muted small">
            {t('console.feedback.newNote')} {t('admin.accounts.timeZone')}
          </p>
        </>
      )}
    </section>
  );
}

type Ask = 'one' | 'tester' | null;

/** One report: the tester's own words (never translated), details, and delete. */
export function Report({ id }: { id: string }) {
  const t = useT();
  const { date, go, markSeen, refresh, setNotice } = useConsole();
  const [detail, setDetail] = useState<Loaded<ReportDetail> | null>(null);
  const [ask, setAsk] = useState<Ask>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void loadReport(api, id).then((d) => {
      if (!live) return;
      setDetail(d);
      if (d.ok) markSeen(id);
    });
    return () => {
      live = false;
    };
  }, [id]);
  const back = (
    <a
      href="#/feedback"
      class="back"
      data-testid="report-back"
      onClick={(e) => {
        e.preventDefault();
        go({ name: 'feedback' });
      }}
    >
      {t('admin.reports.back')}
    </a>
  );
  if (!detail) return <Loading />;
  if (!detail.ok)
    return (
      <section class="stack">
        {back}
        <Problem error={detail.error} unavailable="console.reports.unavailable" />
      </section>
    );
  const r = detail.value;
  const kind = r.kind ?? 'bug';
  const confirmed = async () => {
    setBusy(true);
    try {
      if (ask === 'one') {
        const ok = await deleteReport(api, r.id);
        setNotice(ok ? t('admin.reports.deleted') : t('admin.error.network'));
      } else {
        const n = await deleteTesterReports(api, r.principal);
        setNotice(
          n === null ? t('admin.error.network') : t('admin.reports.deletedTester', { count: n }),
        );
      }
      await refresh(['reports']);
      go({ name: 'feedback' });
    } finally {
      setBusy(false);
      setAsk(null);
    }
  };
  return (
    <section aria-labelledby="report-h" class="stack" data-testid="report-detail">
      {back}
      <h1 id="report-h">
        <bdi dir="ltr">{r.id}</bdi>
      </h1>
      <dl class="facts card">
        <div>
          <dt>{t('admin.reports.received')}</dt>
          <dd>{date(r.receivedAt)}</dd>
        </div>
        <div>
          <dt>{t('admin.reports.kind')}</dt>
          <dd>{t(kindKey(kind))}</dd>
        </div>
        {kind === 'bug' && (
          <div>
            <dt>{t('admin.reports.area')}</dt>
            <dd>
              {r.category ? t(categoryKey(r.category)) : '—'}
              {r.blocking ? ` · ${t('admin.reports.blocking')}` : ''}
            </dd>
          </div>
        )}
        {r.component && (
          <div>
            <dt>{t('admin.reports.component')}</dt>
            <dd dir="auto">{r.component}</dd>
          </div>
        )}
        <div>
          <dt>{t('admin.reports.tester')}</dt>
          <dd>
            <bdi dir="ltr">{testerLabel(r.principal)}</bdi>
          </dd>
        </div>
        <div>
          <dt>{t('admin.reports.technical')}</dt>
          <dd>
            <bdi dir="ltr">
              {[
                r.app ? `app ${r.app.version}` : null,
                r.release
                  ? `runtime ${r.release.version}`
                  : r.context?.runtime
                    ? `runtime ${r.context.runtime}`
                    : null,
                `${r.browser.family}${r.browser.major ? ` ${r.browser.major}` : ''} / ${r.browser.os}`,
                r.context?.device ?? null,
                r.context?.projectId ?? null,
                r.locale,
              ]
                .filter(Boolean)
                .join(' · ')}
            </bdi>
          </dd>
        </div>
      </dl>
      {/* The tester's own words: shown as written, never translated. */}
      <p class="report-text card" dir="auto" data-testid="report-text">
        {r.description}
      </p>
      {ask ? (
        <Confirm
          title={t(
            ask === 'one' ? 'admin.confirm.title.deleteReport' : 'admin.confirm.title.deleteTester',
          )}
          action={t(ask === 'one' ? 'admin.reports.delete' : 'admin.reports.deleteTester')}
          danger
          busy={busy}
          onCancel={() => setAsk(null)}
          onConfirm={() => void confirmed()}
        >
          <p>
            {ask === 'one'
              ? t('admin.reports.delete.confirm', { id: r.id })
              : t('admin.reports.deleteTester.confirm', { tester: testerLabel(r.principal) })}
          </p>
        </Confirm>
      ) : (
        <div class="actions">
          <button
            type="button"
            class="button button-danger"
            data-testid="report-delete"
            onClick={() => setAsk('one')}
          >
            {t('admin.reports.delete')}
          </button>
          <button
            type="button"
            class="button button-danger"
            data-testid="report-delete-tester"
            onClick={() => setAsk('tester')}
          >
            {t('admin.reports.deleteTester')}
          </button>
        </div>
      )}
    </section>
  );
}

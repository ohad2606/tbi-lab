/**
 * Sprint 23B: the owner's administration (testers and feedback), a modal dialog opened from the
 * status bar. Present only when the build enables it (ADMIN_UI) AND the Session Host confirmed
 * that the signed-in account is the owner; every call is authorized again by the server, so this
 * UI only hides. The logic lives in admin.ts.
 *
 * Addresses are masked by the server; the one the owner types to add a tester stays in this
 * dialog only, masked by default (a "show" toggle reveals it to the owner). Actions that end
 * someone's access say exactly what happens and need a confirmation.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { ADMIN_UI } from '../deployment.js';
import { gateFetch } from '../gate.js';
import type { MessageKey } from '../i18n/i18n.js';
import { useAppState, useT } from './context.js';
import {
  addTester,
  capText,
  deleteReport,
  deleteTesterReports,
  loadAccounts,
  loadCapacity,
  loadReport,
  loadReports,
  maskAddress,
  plausibleAddress,
  requestResult,
  setAccess,
  testerLabel,
  type AccountRow,
  type AccountsView,
  type Capacity,
  type LoadError,
  type Loaded,
  type MutationOutcome,
  type ReportDetail,
  type ReportMeta,
} from './admin.js';

const listeners = new Set<(trigger: HTMLElement | null) => void>();
/** Open the administration; focus returns to `trigger` when it closes. */
export function openAdmin(trigger: HTMLElement | null): void {
  for (const l of listeners) l(trigger);
}

const api = (input: string, init?: RequestInit) => gateFetch(input, init);

/** Mounted once (App). */
export function AdminHost() {
  const [trigger, setTrigger] = useState<{ el: HTMLElement | null } | null>(null);
  useEffect(() => {
    const open = (el: HTMLElement | null) => setTrigger({ el });
    listeners.add(open);
    return () => void listeners.delete(open);
  }, []);
  if (!ADMIN_UI || !trigger) return null;
  return <AdminDialog trigger={trigger.el} onClose={() => setTrigger(null)} />;
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

type Confirm =
  | { kind: 'disable' | 'reactivate'; account: AccountRow }
  | { kind: 'deleteReport'; id: string }
  | { kind: 'deleteTester'; principal: string };

function AdminDialog({ trigger, onClose }: { trigger: HTMLElement | null; onClose: () => void }) {
  const t = useT();
  const { locale } = useAppState();
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<'testers' | 'reports'>('testers');
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Loaded<AccountsView> | null>(null);
  const [capacity, setCapacity] = useState<Loaded<Capacity> | null>(null);
  const [reports, setReports] = useState<Loaded<ReportMeta[]> | null>(null);
  const [detail, setDetail] = useState<Loaded<ReportDetail> | null>(null);
  const [busy, setBusy] = useState(false);
  const unmounting = useRef(false);

  const refreshTesters = async () => {
    const [a, c] = await Promise.all([loadAccounts(api), loadCapacity(api)]);
    setAccounts(a);
    setCapacity(c);
  };
  const refreshReports = async () => setReports(await loadReports(api));

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    d?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    void refreshTesters();
    void refreshReports();
    return () => {
      unmounting.current = true;
      d?.close();
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);

  // A confirmation takes focus on its safe choice; leaving it returns to the dialog's content.
  useEffect(() => {
    const d = dialog.current;
    if (confirm) d?.querySelector<HTMLElement>('[data-testid="admin-confirm-cancel"]')?.focus();
    else d?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }, [confirm]);

  const date = (iso: string | null, withTime = true) => {
    if (!iso) return null;
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return null;
    return new Intl.DateTimeFormat(
      locale.code,
      withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' },
    ).format(ms);
  };

  const errorText = (e: LoadError) => t(`admin.error.${e}` as MessageKey);

  const outcomeText = (
    o: MutationOutcome,
    masked: string,
    action: 'add' | 'disable' | 'reactivate',
  ): string => {
    if (o.kind === 'pending') return t('admin.result.pending', { id: o.id });
    if (o.kind === 'refused')
      return o.error === 'invalid_email'
        ? t('admin.add.invalid')
        : t(
            `admin.error.${o.error === 'invalid' || o.error === 'csrf' ? 'network' : o.error}` as MessageKey,
          );
    if (o.code === 'forbidden' && o.ownerPending) return t('admin.result.ownerPending');
    const key = o.code === 'done' ? `admin.result.done.${action}` : `admin.result.${o.code}`;
    return t(key as MessageKey, { account: o.masked ?? masked });
  };

  const runConfirmed = async () => {
    if (!confirm || busy) return;
    setBusy(true);
    try {
      if (confirm.kind === 'disable' || confirm.kind === 'reactivate') {
        const o = await setAccess(api, confirm.kind, confirm.account.target);
        setNotice(outcomeText(o, confirm.account.masked, confirm.kind));
        await refreshTesters();
      } else if (confirm.kind === 'deleteReport') {
        const ok = await deleteReport(api, confirm.id);
        setNotice(ok ? t('admin.reports.deleted') : t('admin.error.network'));
        setDetail(null);
        await refreshReports();
      } else if (confirm.kind === 'deleteTester') {
        const n = await deleteTesterReports(api, confirm.principal);
        setNotice(
          n === null ? t('admin.error.network') : t('admin.reports.deletedTester', { count: n }),
        );
        setDetail(null);
        await refreshReports();
      }
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const list = [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (!list.length) return;
    const first = list[0]!;
    const last = list[list.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const onTabKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End')
      return;
    e.preventDefault();
    const next = tab === 'testers' ? 'reports' : 'testers';
    setTab(next);
    requestAnimationFrame(() =>
      dialog.current?.querySelector<HTMLElement>(`[data-testid="admin-tab-${next}"]`)?.focus(),
    );
  };

  return (
    <dialog
      ref={dialog}
      class="dialog admin-dialog"
      dir={locale.dir}
      aria-labelledby="admin-title"
      data-testid="admin-dialog"
      onKeyDown={onKeyDown}
      onCancel={(e) => {
        e.preventDefault();
        if (busy) return;
        if (confirm) setConfirm(null);
        else onClose();
      }}
      onClose={() => !unmounting.current && onClose()}
    >
      <div class="admin-head">
        <h2 id="admin-title">{t('admin.title')}</h2>
        <button
          type="button"
          class="button button-quiet"
          data-testid="admin-close"
          onClick={() => !busy && onClose()}
        >
          {t('admin.close')}
        </button>
      </div>
      <p class="small admin-owner-note">{t('admin.ownerOnly')}</p>
      <div role="status" class="admin-notice" data-testid="admin-notice">
        {notice ?? ''}
      </div>
      {confirm ? (
        <ConfirmPanel
          confirm={confirm}
          cap={accounts?.ok ? accounts.value.cap : null}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void runConfirmed()}
        />
      ) : (
        <>
          <div role="tablist" class="admin-tabs" aria-label={t('admin.title')}>
            {(['testers', 'reports'] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                id={`admin-tab-${k}`}
                class="admin-tab"
                data-testid={`admin-tab-${k}`}
                aria-selected={tab === k}
                aria-controls={`admin-panel-${k}`}
                tabIndex={tab === k ? 0 : -1}
                onKeyDown={onTabKey}
                onClick={() => setTab(k)}
              >
                {t(`admin.tab.${k}` as MessageKey)}
              </button>
            ))}
          </div>
          {tab === 'testers' ? (
            <section
              role="tabpanel"
              id="admin-panel-testers"
              aria-labelledby="admin-tab-testers"
              data-testid="admin-panel-testers"
            >
              <Capacities accounts={accounts} capacity={capacity} errorText={errorText} />
              <AddTester
                onDone={async (text) => {
                  setNotice(text);
                  await refreshTesters();
                }}
                outcomeText={outcomeText}
              />
              <Accounts
                accounts={accounts}
                date={date}
                errorText={errorText}
                onAsk={(c) => {
                  setNotice(null);
                  setConfirm(c);
                }}
              />
            </section>
          ) : (
            <section
              role="tabpanel"
              id="admin-panel-reports"
              aria-labelledby="admin-tab-reports"
              data-testid="admin-panel-reports"
            >
              {detail ? (
                <ReportView
                  detail={detail}
                  date={date}
                  errorText={errorText}
                  onBack={() => setDetail(null)}
                  onAsk={(c) => {
                    setNotice(null);
                    setConfirm(c);
                  }}
                />
              ) : (
                <ReportList
                  reports={reports}
                  date={date}
                  errorText={errorText}
                  onOpen={async (id) => setDetail(await loadReport(api, id))}
                />
              )}
            </section>
          )}
        </>
      )}
    </dialog>
  );
}

function Capacities({
  accounts,
  capacity,
  errorText,
}: {
  accounts: Loaded<AccountsView> | null;
  capacity: Loaded<Capacity> | null;
  errorText: (e: LoadError) => string;
}) {
  const t = useT();
  return (
    <dl class="admin-capacity" data-testid="admin-capacity">
      <div>
        <dt>{t('admin.capacity.testers')}</dt>
        <dd data-testid="admin-capacity-testers">
          {accounts?.ok ? (
            <bdi dir="ltr">
              {capText(accounts.value).n} / {capText(accounts.value).cap}
            </bdi>
          ) : accounts ? (
            errorText(accounts.error)
          ) : (
            '…'
          )}
          <span class="small"> {t('admin.capacity.ownerExcluded')}</span>
        </dd>
      </div>
      <div>
        <dt>{t('admin.capacity.sessions')}</dt>
        <dd data-testid="admin-capacity-sessions">
          {capacity?.ok ? (
            <bdi dir="ltr">
              {capacity.value.live} / {capacity.value.max}
            </bdi>
          ) : capacity ? (
            errorText(capacity.error)
          ) : (
            '…'
          )}
        </dd>
      </div>
    </dl>
  );
}

function AddTester({
  onDone,
  outcomeText,
}: {
  onDone: (text: string) => Promise<void>;
  outcomeText: (o: MutationOutcome, masked: string, action: 'add') => string;
}) {
  const t = useT();
  const [email, setEmail] = useState('');
  const [problem, setProblem] = useState(false);
  const [sending, setSending] = useState(false);
  const [last, setLast] = useState<{ address: string; pendingId: string | null } | null>(null);
  const [reveal, setReveal] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  const submit = async () => {
    if (sending) return;
    if (!plausibleAddress(email)) {
      setProblem(true);
      field.current?.focus();
      return;
    }
    setProblem(false);
    setSending(true);
    const typed = email.trim().toLowerCase();
    const o = await addTester(api, typed);
    setSending(false);
    if (o.kind === 'refused' && o.error === 'invalid_email') {
      setProblem(true);
      field.current?.focus();
      return;
    }
    setEmail('');
    setReveal(false);
    setLast({ address: typed, pendingId: o.kind === 'pending' ? o.id : null });
    await onDone(outcomeText(o, maskAddress(typed), 'add'));
  };

  const checkAgain = async () => {
    if (!last?.pendingId) return;
    const o = await requestResult(api, last.pendingId);
    if (o.kind !== 'pending') setLast({ ...last, pendingId: null });
    await onDone(outcomeText(o, maskAddress(last.address), 'add'));
  };

  return (
    <form
      class="admin-add"
      noValidate
      data-testid="admin-add"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3>{t('admin.add.heading')}</h3>
      <label for="admin-add-email" class="report-label">
        {t('admin.add.label')}
      </label>
      <div class="admin-add-row">
        <input
          ref={field}
          id="admin-add-email"
          type="email"
          dir="ltr"
          autoComplete="off"
          spellcheck={false}
          data-testid="admin-add-email"
          value={email}
          readOnly={sending}
          aria-invalid={problem}
          aria-describedby={problem ? 'admin-add-hint admin-add-problem' : 'admin-add-hint'}
          onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
        />
        <button
          type="submit"
          class="button button-primary"
          data-testid="admin-add-submit"
          aria-disabled={sending ? 'true' : undefined}
        >
          {sending ? t('admin.add.sending') : t('admin.add.submit')}
        </button>
      </div>
      <p id="admin-add-hint" class="small">
        {t('admin.add.hint')}
      </p>
      {problem && (
        <p id="admin-add-problem" class="report-problem" data-testid="admin-add-problem">
          {t('admin.add.invalid')}
        </p>
      )}
      {last && (
        <p class="small admin-add-last" data-testid="admin-add-last">
          {t('admin.add.last')}{' '}
          <bdi dir="ltr" data-testid="admin-add-last-address">
            {reveal ? last.address : maskAddress(last.address)}
          </bdi>{' '}
          <button
            type="button"
            class="text-button"
            aria-pressed={reveal}
            data-testid="admin-add-reveal"
            onClick={() => setReveal((r) => !r)}
          >
            {reveal ? t('admin.add.hide') : t('admin.add.show')}
          </button>
          {last.pendingId && (
            <>
              {' '}
              <button
                type="button"
                class="text-button"
                data-testid="admin-add-check"
                onClick={() => void checkAgain()}
              >
                {t('admin.add.checkAgain')}
              </button>
            </>
          )}
        </p>
      )}
    </form>
  );
}

function Accounts({
  accounts,
  date,
  errorText,
  onAsk,
}: {
  accounts: Loaded<AccountsView> | null;
  date: (iso: string | null, withTime?: boolean) => string | null;
  errorText: (e: LoadError) => string;
  onAsk: (c: Confirm) => void;
}) {
  const t = useT();
  if (!accounts) return <p class="small">{t('admin.loading')}</p>;
  if (!accounts.ok)
    return (
      <p role="alert" class="report-error" data-testid="admin-accounts-error">
        {errorText(accounts.error)}
      </p>
    );
  const v = accounts.value;
  const masked = (target: string | null) =>
    v.accounts.find((a) => a.target === target)?.masked ?? '***';
  return (
    <>
      {v.warnings.length > 0 && (
        <section
          class="admin-warnings"
          data-testid="admin-warnings"
          aria-labelledby="admin-warnings-h"
        >
          <h3 id="admin-warnings-h">{t('admin.warnings.heading')}</h3>
          <ul>
            {v.warnings.map((w, i) => (
              <li key={i} data-testid="admin-warning" data-kind={w.kind}>
                {w.kind === 'identity_mismatch'
                  ? t('admin.warnings.identity_mismatch', {
                      account: masked(w.target),
                      count: w.count ?? 1,
                      last: date(w.last) ?? '—',
                    })
                  : t('admin.warnings.other', { account: masked(w.target), kind: w.kind })}
              </li>
            ))}
          </ul>
        </section>
      )}
      <h3>{t('admin.accounts.heading')}</h3>
      <p class="small">{t('admin.accounts.effect')}</p>
      <div class="admin-table-wrap">
        <table class="admin-table" data-testid="admin-accounts">
          <thead>
            <tr>
              <th scope="col">{t('admin.accounts.account')}</th>
              <th scope="col">{t('admin.accounts.class')}</th>
              <th scope="col">{t('admin.accounts.status')}</th>
              <th scope="col">{t('admin.accounts.added')}</th>
              <th scope="col">{t('admin.accounts.googleId')}</th>
              <th scope="col">{t('admin.accounts.lastSignIn')}</th>
              <th scope="col">
                <span class="visually-hidden">{t('admin.accounts.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {v.accounts.map((a) => (
              <tr key={a.target} data-testid={`admin-account-${a.target}`} data-status={a.status}>
                <td>
                  <bdi dir="ltr">{a.masked}</bdi>
                </td>
                <td>{t(`admin.class.${a.class}` as MessageKey)}</td>
                <td>
                  <span class={`admin-status admin-status-${a.status}`}>
                    {t(`admin.status.${a.status}` as MessageKey)}
                  </span>
                </td>
                <td>{date(a.dateAdded, false) ?? '—'}</td>
                <td>{a.googleIdRecorded ? t('admin.yes') : t('admin.no')}</td>
                <td>{date(a.lastSignIn) ?? t('admin.notMeasured')}</td>
                <td>
                  {a.class === 'owner' ? null : a.status === 'revoked' ? (
                    <button
                      type="button"
                      class="button"
                      data-testid={`admin-reactivate-${a.target}`}
                      aria-label={t('admin.reactivate.label', { account: a.masked })}
                      onClick={() => onAsk({ kind: 'reactivate', account: a })}
                    >
                      {t('admin.reactivate')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      class="button button-danger"
                      data-testid={`admin-disable-${a.target}`}
                      aria-label={t('admin.disable.label', { account: a.masked })}
                      onClick={() => onAsk({ kind: 'disable', account: a })}
                    >
                      {t('admin.disable')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ConfirmPanel({
  confirm,
  cap,
  busy,
  onCancel,
  onConfirm,
}: {
  confirm: Confirm;
  cap: number | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const account = 'account' in confirm ? confirm.account.masked : '';
  const body: string[] =
    confirm.kind === 'disable'
      ? [
          t('admin.disable.confirm.what', { account }),
          t('admin.disable.confirm.signIn'),
          t('admin.disable.confirm.requests'),
          t('admin.disable.confirm.sessions'),
          t('admin.disable.confirm.kept'),
        ]
      : confirm.kind === 'reactivate'
        ? [
            t('admin.reactivate.confirm.what', { account }),
            t('admin.reactivate.confirm.cap', { cap: cap ?? 20 }),
          ]
        : confirm.kind === 'deleteReport'
          ? [t('admin.reports.delete.confirm', { id: confirm.id })]
          : confirm.kind === 'deleteTester'
            ? [t('admin.reports.deleteTester.confirm', { tester: testerLabel(confirm.principal) })]
            : [];
  const action =
    confirm.kind === 'disable'
      ? t('admin.disable.confirm.action')
      : confirm.kind === 'reactivate'
        ? t('admin.reactivate.confirm.action')
        : confirm.kind === 'deleteReport'
          ? t('admin.reports.delete')
          : t('admin.reports.deleteTester');
  return (
    <section
      role="alertdialog"
      aria-modal="false"
      aria-labelledby="admin-confirm-title"
      aria-describedby="admin-confirm-body"
      class="admin-confirm"
      data-testid="admin-confirm"
      data-kind={confirm.kind}
    >
      <h3 id="admin-confirm-title">{t(`admin.confirm.title.${confirm.kind}` as MessageKey)}</h3>
      <div id="admin-confirm-body">
        {confirm.kind === 'disable' ? (
          <>
            <p>{body[0]}</p>
            <ul>
              {body.slice(1, 4).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p>{body[4]}</p>
          </>
        ) : (
          body.map((line) => <p key={line}>{line}</p>)
        )}
      </div>
      <div class="dialog-actions">
        <button
          type="button"
          class="button"
          data-testid="admin-confirm-cancel"
          aria-disabled={busy ? 'true' : undefined}
          onClick={() => !busy && onCancel()}
        >
          {t('admin.cancel')}
        </button>
        <button
          type="button"
          class={`button ${confirm.kind === 'reactivate' ? 'button-primary' : 'button-danger'}`}
          data-testid="admin-confirm-ok"
          aria-disabled={busy ? 'true' : undefined}
          onClick={onConfirm}
        >
          {busy ? t('admin.working') : action}
        </button>
      </div>
    </section>
  );
}

function ReportList({
  reports,
  date,
  errorText,
  onOpen,
}: {
  reports: Loaded<ReportMeta[]> | null;
  date: (iso: string | null) => string | null;
  errorText: (e: LoadError) => string;
  onOpen: (id: string) => void;
}) {
  const t = useT();
  if (!reports) return <p class="small">{t('admin.loading')}</p>;
  if (!reports.ok)
    return (
      <p role="alert" class="report-error" data-testid="admin-reports-error">
        {errorText(reports.error)}
      </p>
    );
  if (!reports.value.length)
    return (
      <p class="small" data-testid="admin-reports-empty">
        {t('admin.reports.empty')}
      </p>
    );
  return (
    <div class="admin-table-wrap">
      <table class="admin-table" data-testid="admin-reports">
        <thead>
          <tr>
            <th scope="col">{t('admin.reports.received')}</th>
            <th scope="col">{t('admin.reports.kind')}</th>
            <th scope="col">{t('admin.reports.area')}</th>
            <th scope="col">{t('admin.reports.tester')}</th>
            <th scope="col">{t('admin.reports.length')}</th>
            <th scope="col">
              <span class="visually-hidden">{t('admin.accounts.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {reports.value.map((r) => (
            <tr key={r.id} data-testid={`admin-report-${r.id}`}>
              <td>{date(r.receivedAt) ?? '—'}</td>
              <td>
                {r.kind ? t(`report.kind.${r.kind}` as MessageKey) : t('admin.reports.unreadable')}
                {r.blocking ? (
                  <span class="admin-badge"> {t('admin.reports.blocking')}</span>
                ) : null}
              </td>
              <td>{r.category ? t(`report.category.${r.category}` as MessageKey) : '—'}</td>
              <td>
                <bdi dir="ltr">{testerLabel(r.principal)}</bdi>
              </td>
              <td>
                <bdi dir="ltr">{r.length}</bdi>
              </td>
              <td>
                <button
                  type="button"
                  class="button"
                  data-testid={`admin-open-${r.id}`}
                  aria-label={t('admin.reports.open.label', { id: r.id })}
                  onClick={() => onOpen(r.id)}
                >
                  {t('admin.reports.open')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReportView({
  detail,
  date,
  errorText,
  onBack,
  onAsk,
}: {
  detail: Loaded<ReportDetail>;
  date: (iso: string | null) => string | null;
  errorText: (e: LoadError) => string;
  onBack: () => void;
  onAsk: (c: Confirm) => void;
}) {
  const t = useT();
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => back.current?.focus(), []);
  const r = detail.ok ? detail.value : null;
  const kind = r?.kind ?? 'bug';
  return (
    <div class="admin-report" data-testid="admin-report-detail">
      <button
        ref={back}
        type="button"
        class="button button-quiet"
        onClick={onBack}
        data-testid="admin-report-back"
      >
        {t('admin.reports.back')}
      </button>
      {!r ? (
        <p role="alert" class="report-error">
          {errorText(detail.ok ? 'network' : detail.error)}
        </p>
      ) : (
        <>
          <h3>
            <bdi dir="ltr">{r.id}</bdi>
          </h3>
          <dl class="admin-report-meta">
            <div>
              <dt>{t('admin.reports.received')}</dt>
              <dd>{date(r.receivedAt)}</dd>
            </div>
            <div>
              <dt>{t('admin.reports.kind')}</dt>
              <dd>{t(`report.kind.${kind}` as MessageKey)}</dd>
            </div>
            {kind === 'bug' && (
              <div>
                <dt>{t('admin.reports.area')}</dt>
                <dd>
                  {t(`report.category.${r.category}` as MessageKey)}
                  {r.blocking ? ` · ${t('admin.reports.blocking')}` : ''}
                </dd>
              </div>
            )}
            {r.component && (
              <div>
                <dt>{t('admin.reports.component')}</dt>
                <dd dir="auto" data-testid="admin-report-component">
                  {r.component}
                </dd>
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
          <p class="admin-report-text" dir="auto" data-testid="admin-report-text">
            {r.description}
          </p>
          <div class="dialog-actions">
            <button
              type="button"
              class="button button-danger"
              data-testid="admin-report-delete"
              onClick={() => onAsk({ kind: 'deleteReport', id: r.id })}
            >
              {t('admin.reports.delete')}
            </button>
            <button
              type="button"
              class="button button-danger"
              data-testid="admin-report-delete-tester"
              onClick={() => onAsk({ kind: 'deleteTester', principal: r.principal })}
            >
              {t('admin.reports.deleteTester')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

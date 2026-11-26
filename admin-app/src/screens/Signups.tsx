import { useEffect, useRef, useState } from 'preact/hooks';
import {
  loadAutoApproveStatus,
  loadOpenSignups,
  signupAction,
  type AutoApproveStatus,
  type Loaded,
  type SignupAction,
  type SignupRecord,
} from '@tbi-lab/admin-client';
import { Confirm, Loading, Problem } from '../common.js';
import { api, useConsole, useT } from '../context.js';
import type { MessageKey } from '../i18n.js';
import {
  autoApproveView,
  autoStateClass,
  focusAfterRemoval,
  isAutoApproved,
  signupCountView,
  signupSource,
  signupOutcomeView,
  signupRowKind,
  type SignupRowKind,
} from '../views.js';

/** A person's name inside a sentence or an accessible name: isolated, so it cannot reorder the text. */
const isolate = (s: string) => `⁨${s}⁩`;

/** Placeholder swapped for the time, so it can sit in its own left-to-right <bdi>. */
const SLOT = '\uE000';

interface RowMessage {
  key: MessageKey;
  ok: boolean;
}

const STATUS_KEY: Record<SignupRowKind, MessageKey> = {
  decide: 'console.signups.status.pending',
  retry: 'console.signups.status.accountPending',
  resend: 'console.signups.status.emailFailed',
  queued: 'console.signups.status.emailQueued',
};

/** The element that takes focus in a row: its primary button, else (no action) the row itself. */
const rowFocus = (id: string) =>
  document.querySelector<HTMLElement>(`[data-signup-id="${id}"] button[data-primary]`) ??
  document.querySelector<HTMLElement>(`[data-signup-id="${id}"][tabindex="-1"]`);

/** How long the count announcement waits for the auto-approve status before it is spoken alone. */
const STATUS_WAIT_MS = 3000;

const N_SLOT = '\uE000';
const C_SLOT = '\uE001';

/**
 * Read-only status of the automatic approver (BETA-G1). Off is one line (the owner should see that
 * it is off); on shows today's count against the cap, the state as text (not colour alone), and the
 * older backlog. Numbers and codes are left-to-right inside <bdi>; an unreadable value is the word
 * "unknown", never 0. Loaded on open and by Refresh only; not a live region (no polling).
 */
function AutoApproveBlock({ status }: { status: Loaded<AutoApproveStatus> | null }) {
  const t = useT();
  const val = (v: number | 'unknown') =>
    v === 'unknown' ? (
      <bdi dir="auto" data-testid="auto-unknown">
        {t('console.signups.auto.value.unknown')}
      </bdi>
    ) : (
      <bdi dir="ltr">{v}</bdi>
    );
  let body;
  if (!status) body = <Loading />;
  else if (!status.ok)
    body = (
      <p class="result warn" data-testid="auto-unavailable">
        {t('console.signups.auto.unavailable')}
      </p>
    );
  else {
    const v = autoApproveView(status.value);
    if (v.mode === 'off')
      body = (
        <p class="muted" data-testid="auto-off">
          {t('console.signups.auto.off')}
        </p>
      );
    else if (v.mode === 'unknown')
      body = (
        <p class="result warn" data-testid="auto-unknown-mode">
          {t('console.signups.auto.unknown')}
        </p>
      );
    else {
      const cls = autoStateClass(v.state);
      body = (
        <>
          <p data-testid="auto-today">
            {t('console.signups.auto.today', { count: N_SLOT, cap: C_SLOT })
              .split(/(\uE000|\uE001)/)
              .map((part) =>
                part === N_SLOT ? val(v.count) : part === C_SLOT ? val(v.dailyCap) : part,
              )}
          </p>
          {v.capReached && (
            <p class="small" data-testid="auto-cap-reached">
              {t('console.signups.auto.capReached')}
            </p>
          )}
          <p>
            {t('console.signups.auto.state.label')}:{' '}
            <span class={`badge ${cls}`} data-testid="auto-state" data-state={v.state}>
              {t(`console.signups.auto.state.${v.state}` as MessageKey)}
            </span>
          </p>
          {v.reason && (
            <p class="small" data-testid="auto-reason">
              {t('console.signups.auto.reason', { code: N_SLOT })
                .split(N_SLOT)
                .flatMap((part, i) =>
                  i === 0
                    ? [part]
                    : [
                        <bdi key={i} dir="ltr" class="code">
                          {v.reason}
                        </bdi>,
                        part,
                      ],
                )}
            </p>
          )}
          <p class="small" data-testid="auto-backlog">
            {t('console.signups.auto.backlog', { count: N_SLOT })
              .split(N_SLOT)
              .flatMap((part, i) =>
                i === 0 ? [part] : [<span key={i}>{val(v.waitingBacklog)}</span>, part],
              )}
          </p>
        </>
      );
    }
  }
  return (
    <section aria-labelledby="signups-auto-h" class="item" data-testid="auto-status">
      <h2 id="signups-auto-h">{t('console.signups.auto.heading')}</h2>
      {body}
    </section>
  );
}

/**
 * Open sign-up requests (TBI-022, owner-only): undecided ones, and approved ones whose account or
 * email has not finished, so a failed or queued email is still here after a reload. Approve adds
 * the account and sends the email; Reject asks first and sends nothing; Resend appears when the
 * email failed (or its outcome is unknown); a queued email shows its send time. Every outcome is
 * a visible sentence on the row and the same sentence in a polite live region.
 */
export function Signups() {
  const t = useT();
  const { date } = useConsole();
  const [list, setList] = useState<Loaded<SignupRecord[]> | null>(null);
  const [autoStatus, setAutoStatus] = useState<Loaded<AutoApproveStatus> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, RowMessage>>({});
  const [announce, setAnnounce] = useState('');
  const focusId = useRef<string | null | undefined>(undefined);
  const refreshBtn = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const [keptTick, setKeptTick] = useState(0);
  const keptId = useRef<string | null>(null);

  // A live region only speaks when its text changes: clear it, then set it on the next frame, so
  // the same sentence twice in a row is announced twice.
  // `spoken` counts announcements and reloads, so a reload that was overtaken stays silent.
  const spoken = useRef(0);
  const say = (text: string) => {
    const n = ++spoken.current;
    setAnnounce('');
    requestAnimationFrame(() => {
      if (alive.current && n === spoken.current) setAnnounce(text);
    });
  };

  const reload = async () => {
    // The status is independent of the list: its failure shows its own message and never blocks it.
    const turn = ++spoken.current;
    const status = loadAutoApproveStatus(api).then((st) => {
      if (alive.current) setAutoStatus(st);
      return st;
    });
    const v = await loadOpenSignups(api);
    if (!alive.current) return;
    setList(v);
    setMessages({});
    setConfirming(null);
    if (v.ok) {
      const c = signupCountView(v.value);
      const count = t(c.key, { count: c.count });
      // One announcement for both: a failed status is added to the count (a hung one is not waited for).
      const st = await Promise.race([
        status,
        new Promise<null>((r) => setTimeout(() => r(null), STATUS_WAIT_MS)),
      ]);
      if (!alive.current || turn !== spoken.current) return;
      say(st && !st.ok ? `${count}. ${t('console.signups.auto.unavailable')}` : count);
      if (st) return;
      // The status was not waited for: a failure arriving later is shown, so it is also spoken,
      // unless a newer announcement or reload came first.
      const after = spoken.current;
      const late = await status;
      if (alive.current && !late.ok && after === spoken.current)
        say(t('console.signups.auto.unavailable'));
    }
  };
  useEffect(() => {
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
    };
  }, []);

  // After a row left the list, focus goes to the next row's first action, else the previous
  // row's, else the refresh button: never to the top of the page.
  useEffect(() => {
    if (focusId.current === undefined) return;
    const id = focusId.current;
    focusId.current = undefined;
    const target = id ? rowFocus(id) : null;
    (target ?? refreshBtn.current)?.focus();
  }, [list]);

  // After an outcome that keeps the row (an error, or Approve turning into Resend), focus goes to
  // that row's primary button, which may be a different element than the one that was pressed;
  // a row left without an action (its email now queued) focuses its outcome sentence.
  useEffect(() => {
    const id = keptId.current;
    if (!id) return;
    keptId.current = null;
    requestAnimationFrame(() =>
      (
        document.querySelector<HTMLElement>(`[data-signup-id="${id}"] button[data-primary]`) ??
        document.querySelector<HTMLElement>(
          `[data-signup-id="${id}"] [data-testid="signup-message"]`,
        ) ??
        rowFocus(id) ??
        refreshBtn.current
      )?.focus(),
    );
  }, [keptTick]);

  const act = async (r: SignupRecord, action: SignupAction) => {
    if (busy || !list?.ok) return;
    setBusy(r.id);
    setConfirming(null);
    say(t('console.signups.status.working'));
    if (action === 'reject') {
      // The confirm unmounts now; keep focus on the row while the request runs.
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLElement>(`[data-signup-id="${r.id}"] button[data-act="reject"]`)
          ?.focus(),
      );
    }
    try {
      const o = await signupAction(api, r.id, action);
      if (!alive.current) return;
      const v = signupOutcomeView(o, action);
      const text = t(v.key as MessageKey, { name: isolate(r.name) });
      const ids = list.value.map((x) => x.id);
      // A row that stays without an action gets focus on its outcome sentence, which is read on
      // focus: no live announcement then (it would be read twice). Every other outcome is spoken
      // by the live region (the row is gone, or focus is on a button).
      const messageFocused = !v.removed && signupRowKind(v.record ?? r) === 'queued';
      if (messageFocused) {
        // Silence counts as an announcement: a pending one (e.g. a late status) must not follow.
        spoken.current++;
        setAnnounce('');
      } else say(text);
      if (v.removed) {
        focusId.current = focusAfterRemoval(ids, r.id);
        setList({ ok: true, value: list.value.filter((x) => x.id !== r.id) });
      } else {
        if (v.record) {
          const rec = v.record;
          setList({ ok: true, value: list.value.map((x) => (x.id === r.id ? rec : x)) });
        }
        setMessages((m) => ({ ...m, [r.id]: { key: v.key as MessageKey, ok: v.ok } }));
        keptId.current = r.id;
        setKeptTick((n) => n + 1);
      }
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  // Only rows that need the owner are counted (a queued email needs nothing).
  const countLine = list?.ok ? signupCountView(list.value) : null;
  return (
    <section aria-labelledby="signups-h" class="stack">
      <h1 id="signups-h">{t('console.signups.heading')}</h1>
      <p class="muted">{t('console.signups.intro')}</p>
      <div class="actions">
        <button
          ref={refreshBtn}
          type="button"
          class="button"
          data-testid="signups-refresh"
          onClick={() => void reload()}
        >
          {t('console.signups.refresh')}
        </button>
      </div>
      <div role="status" aria-live="polite" class="visually-hidden" data-testid="signups-live">
        {announce}
      </div>
      <AutoApproveBlock status={autoStatus} />
      {!list ? (
        <Loading />
      ) : !list.ok ? (
        <Problem
          error={list.error}
          unavailable="console.signups.unavailable"
          testid="signups-problem"
        />
      ) : list.value.length === 0 ? (
        <p class="muted" data-testid="signups-empty">
          {t('console.signups.empty')}
        </p>
      ) : (
        <>
          <p class="muted small" data-testid="signups-count">
            {t(countLine!.key, { count: countLine!.count })}
          </p>
          <ul class="list" data-testid="signups-list">
            {list.value.map((r) => {
              const working = busy === r.id;
              const msg = messages[r.id];
              const kind = signupRowKind(r);
              const name = isolate(r.name);
              const src = signupSource(r);
              const langKey = `console.signups.lang.${r.lang}` as MessageKey;
              return (
                <li
                  key={r.id}
                  class="item"
                  data-testid="signup-row"
                  data-signup-id={r.id}
                  data-kind={kind}
                  tabIndex={kind === 'queued' ? -1 : undefined}
                >
                  <div class="item-head">
                    <strong>
                      <bdi dir="auto">{r.name}</bdi>
                    </strong>
                    <span class="badge" data-testid="signup-status">
                      {t(working ? 'console.signups.status.working' : STATUS_KEY[kind])}
                    </span>
                    {src.web && (
                      <span class="badge" data-testid="signup-origin-web">
                        {t('console.signups.origin.web')}
                      </span>
                    )}
                    {isAutoApproved(r) && (
                      <span class="badge badge-auto" data-testid="signup-auto-approved">
                        {t('console.signups.autoApproved')}
                      </span>
                    )}
                  </div>
                  <div>
                    <bdi dir="ltr" class="code" data-testid="signup-email">
                      {r.email}
                    </bdi>
                  </div>
                  <div class="small">
                    {t('console.signups.role')}: <bdi dir="auto">{r.role}</bdi>
                    {' · '}
                    {t('console.signups.language')}:{' '}
                    {t(r.lang === 'he' || r.lang === 'en' ? langKey : 'console.signups.lang.other')}
                  </div>
                  {src.heardFrom && (
                    <div class="small" data-testid="signup-heard-from">
                      {t('console.signups.heardFrom')}: <bdi dir="auto">{src.heardFrom}</bdi>
                    </div>
                  )}
                  <div class="muted small">
                    {t('console.signups.requested', { time: date(r.createdAt) ?? '' })}
                  </div>
                  {kind === 'queued' && r.emailSendAfter && (
                    <div class="small" data-testid="signup-send-after">
                      {t('console.signups.sendAfter', { time: SLOT })
                        .split(SLOT)
                        .flatMap((part, i) =>
                          i === 0
                            ? [part]
                            : [
                                <bdi key={i} dir="ltr">
                                  {date(r.emailSendAfter!) ?? ''}
                                </bdi>,
                                part,
                              ],
                        )}
                    </div>
                  )}
                  {msg && (
                    <p
                      class={`result ${msg.ok ? 'ok' : 'warn'}`}
                      data-testid="signup-message"
                      data-key={msg.key}
                      tabIndex={-1}
                    >
                      {t(msg.key, { name })}
                    </p>
                  )}
                  {confirming === r.id ? (
                    <Confirm
                      title={t('console.signups.confirm.title', { name })}
                      action={t('console.signups.confirm.ok')}
                      danger
                      busy={working}
                      onCancel={() => {
                        setConfirming(null);
                        requestAnimationFrame(() =>
                          document
                            .querySelector<HTMLElement>(
                              `[data-signup-id="${r.id}"] button[data-act="reject"]`,
                            )
                            ?.focus(),
                        );
                      }}
                      onConfirm={() => void act(r, 'reject')}
                    >
                      <p>{t('console.signups.confirm.body')}</p>
                    </Confirm>
                  ) : kind === 'queued' ? null : (
                    <div class="actions">
                      {kind === 'resend' ? (
                        <button
                          type="button"
                          class="button button-primary"
                          data-primary
                          data-act="resend"
                          data-testid="signup-resend"
                          aria-label={t('console.signups.resendFor', { name })}
                          aria-disabled={busy ? 'true' : undefined}
                          onClick={() => void act(r, 'resend')}
                        >
                          {t('console.signups.resend')}
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            class="button button-primary"
                            data-primary
                            data-act="approve"
                            data-testid="signup-approve"
                            aria-label={t('console.signups.approveFor', { name })}
                            aria-disabled={busy ? 'true' : undefined}
                            onClick={() => void act(r, 'approve')}
                          >
                            {t('console.signups.approve')}
                          </button>
                          {kind === 'decide' && (
                            <button
                              type="button"
                              class="button button-danger"
                              data-act="reject"
                              data-testid="signup-reject"
                              aria-label={t('console.signups.rejectFor', { name })}
                              aria-disabled={busy ? 'true' : undefined}
                              onClick={() => !busy && setConfirming(r.id)}
                            >
                              {t('console.signups.reject')}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

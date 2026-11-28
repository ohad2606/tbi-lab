import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import {
  loadAutoApproveStatus,
  loadOpenSignups,
  signupAction,
  type AutoApproveStatus,
  type Loaded,
  type SignupAction,
  type SignupRecord,
  type SignupSafeguards,
} from '@tbi-lab/admin-client';
import { Confirm, Loading, Problem } from '../common.js';
import { api, useConsole, useT } from '../context.js';
import type { MessageKey } from '../i18n.js';
import {
  autoApproveView,
  approveWarningKey,
  autoStateClass,
  focusAfterRemoval,
  isAutoApproved,
  isUnconfirmedRow,
  verificationKey,
  signupCountView,
  signupSource,
  signupBadgeOverride,
  signupOutcomeView,
  signupRowKind,
  signupStatusKey,
} from '../views.js';
import { StoredSignups } from './StoredSignups.js';

/** A person's name inside a sentence or an accessible name: isolated, so it cannot reorder the text. */
const isolate = (s: string) => `⁨${s}⁩`;

/** Placeholder swapped for the time, so it can sit in its own left-to-right <bdi>. */
const SLOT = '\uE000';

interface RowMessage {
  key: MessageKey;
  ok: boolean;
}

/** The row control that holds focus now, so a reload can give focus back to it. */
function focusedInRow(): { id: string; act: string | undefined } | null {
  if (typeof document === 'undefined') return null;
  const at = document.activeElement as HTMLElement | null;
  const id = at?.closest<HTMLElement>('[data-testid="signup-row"]')?.dataset.signupId;
  return id ? { id, act: at!.dataset.act } : null;
}

/** The button that opens and closes the "not confirmed yet" group. */
const groupToggle = () =>
  document.querySelector<HTMLElement>('[data-testid="signups-unconfirmed-toggle"]');

/** Focus never goes into the closed group: its toggle stands in for anything inside it. */
const shown = (e: HTMLElement | null) => (e?.closest('[hidden]') ? groupToggle() : e);

/** The element that takes focus in a row: its primary button, else (no action) the row itself. */
const rowFocus = (id: string) =>
  shown(
    document.querySelector<HTMLElement>(`[data-signup-id="${id}"] button[data-primary]`) ??
      document.querySelector<HTMLElement>(`[data-signup-id="${id}"][tabindex="-1"]`),
  );

/** How long the count announcement waits for the auto-approve status before it is spoken alone. */
const STATUS_WAIT_MS = 3000;

/** A status request still open after this long on Refresh is shown, and said, as pending. */
const PENDING_AFTER_MS = 1000;

/** A status request still unanswered after this long is given up: it ends as unavailable. */
const STATUS_TIMEOUT_MS = 10_000;

/**
 * The shared client's fetch with a time limit, for the read-only status only: an abort (also while
 * the body is read) is a failed load to the client.
 */
const statusApi = async (input: string, init?: RequestInit) => {
  const abort = new AbortController();
  // Not cleared on the answer's headers: the body must arrive in time too.
  setTimeout(() => abort.abort(), STATUS_TIMEOUT_MS);
  return api(input, { ...init, signal: abort.signal });
};

/** How long an announcement may still be unspoken, so an added sentence is posted with it. */
const FRESH_MS = 2000;

/** Two spoken sentences in one announcement. */
const join = (a: string, b: string) => (a ? `${a.replace(/([^.!?…])$/, '$1.')} ${b}` : b);

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

/** A translated sentence with its `{count}` / `{limit}` values isolated left-to-right. */
function Numbers({
  k,
  count,
  limit,
}: {
  k: MessageKey;
  count: number | 'unknown';
  limit?: number | 'unknown';
}) {
  const t = useT();
  const val = (v: number | 'unknown' | undefined) =>
    v === 'unknown' ? (
      <bdi dir="auto">{t('console.signups.auto.value.unknown')}</bdi>
    ) : (
      <bdi dir="ltr">{v}</bdi>
    );
  return (
    <p class="small">
      {t(k, { count: N_SLOT, limit: C_SLOT })
        .split(/(\uE000|\uE001)/)
        .map((part) => (part === N_SLOT ? val(count) : part === C_SLOT ? val(limit) : part))}
    </p>
  );
}

/**
 * BETA-G1 S5: confirmation mails, confirmed requests still waiting, the mail budget and the kill
 * switch, read only. Shown only when the server sends it (also with auto-approve off). Not a live
 * region (loaded on open and by Refresh, like the block above it).
 */
function SafeguardsBlock({ value }: { value: SignupSafeguards }) {
  const t = useT();
  const { verify, mail, paused } = value;
  const state = paused === 'unknown' ? 'unknown' : paused ? 'yes' : 'no';
  return (
    <section aria-labelledby="signups-safeguards-h" class="item" data-testid="signups-safeguards">
      <h2 id="signups-safeguards-h">{t('console.signups.safeguards.heading')}</h2>
      <p class={paused === false ? 'small' : 'result warn'} data-testid="safeguards-paused">
        {t(`console.signups.safeguards.paused.${state}` as MessageKey)}
      </p>
      {verify && (
        <div data-testid="safeguards-verify">
          <Numbers
            k="console.signups.safeguards.verifyToday"
            count={verify.today}
            limit={verify.limit}
          />
          <Numbers k="console.signups.safeguards.verifyWaiting" count={verify.waiting} />
        </div>
      )}
      {mail && (
        <div data-testid="safeguards-mail">
          <Numbers k="console.signups.safeguards.mailDay" count={mail.day} limit={mail.dayLimit} />
          <Numbers k="console.signups.safeguards.mail30d" count={mail.d30} limit={mail.d30Limit} />
        </div>
      )}
    </section>
  );
}

/**
 * An action's answer carries no confirmation state: the row keeps the one it had (so a retry of
 * Approve still asks), and its "approved automatically" mark still needs an added account on a
 * decided request.
 */
const keepState = (next: SignupRecord, old: SignupRecord): SignupRecord => {
  if (old.verification)
    return {
      ...next,
      verification: old.verification,
      autoApprovedAt: next.accountAdded && next.status !== 'pending' ? next.autoApprovedAt : null,
    };
  // A mark the loaded list did not show never appears on a still pending request.
  return old.autoApprovedAt === null && next.status === 'pending'
    ? { ...next, autoApprovedAt: null }
    : next;
};

/**
 * Open sign-up requests (TBI-022, owner-only): undecided ones, and approved ones whose account or
 * email has not finished, so a failed or queued email is still here after a reload. Approve adds
 * the account and sends the email; Reject asks first and sends nothing; Resend appears when the
 * email failed (or its outcome is unknown); a queued email shows its send time. Every outcome is
 * a visible sentence on the row and the same sentence in a polite live region.
 */
export function Signups() {
  const t = useT();
  const { date, locale } = useConsole();
  const [list, setList] = useState<Loaded<SignupRecord[]> | null>(null);
  const [autoStatus, setAutoStatus] = useState<Loaded<AutoApproveStatus> | null>(null);
  const [statusPending, setStatusPending] = useState(false);
  const pendingTimer = useRef<ReturnType<typeof setTimeout>>();
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const [confirming, setConfirming] = useState<string | null>(null);
  const [confirmAct, setConfirmAct] = useState<'approve' | 'reject'>('reject');
  // The "not confirmed yet" group (in memory only), closed until the owner opens it.
  const [groupOpen, setGroupOpen] = useState(false);
  const [messages, setMessages] = useState<Record<string, RowMessage>>({});
  const [announce, setAnnounce] = useState('');
  const [openStale, setOpenStale] = useState(false);
  // Requests whose outcome is unconfirmed while a problem text stands in place of the list.
  const [lost, setLost] = useState<{ id: string; name: string }[]>([]);
  const focusId = useRef<string | null | undefined>(undefined);
  const refreshBtn = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const [keptTick, setKeptTick] = useState(0);
  // K12: bumped when the stored requests may have changed here; ids whose account add may be open.
  const [storedVersion, setStoredVersion] = useState(0);
  const approving = useRef(new Set<string>());
  const keptId = useRef<string | null>(null);
  // The list as it is now (an action's answer arrives later than its click), and the order of the
  // list loads: an older answer never replaces a newer one.
  const listRef = useRef(list);
  listRef.current = list;
  const listTurn = useRef(0);
  const groupOpenRef = useRef(groupOpen);
  groupOpenRef.current = groupOpen;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const autoRef = useRef(autoStatus);
  autoRef.current = autoStatus;

  // A live region only speaks when its text changes: clear it, then set it on the next frame, so
  // the same sentence twice in a row is announced twice.
  // `spoken` counts announcements and reloads (only the latest is put in the region). `topic`
  // changes when an announcement replaces what came before, not when a sentence is added to it,
  // so an addition never silences a reload's count. `reloads` changes with each reload: only a
  // newer one leaves an older status result unshown and unspoken.
  const spoken = useRef(0);
  const topic = useRef(0);
  const reloads = useRef(0);
  const said = useRef('');
  const saidAt = useRef(0);
  // While the delete dialog is modal this page is inert, its live regions too: sentences are
  // held (all of them, joined) and posted when it closes.
  const modal = useRef(false);
  const held = useRef(false);
  const post = (text: string) => {
    said.current = text;
    saidAt.current = performance.now();
    const n = ++spoken.current;
    if (modal.current) {
      held.current = true;
      return;
    }
    setAnnounce('');
    requestAnimationFrame(() => {
      if (alive.current && n === spoken.current) setAnnounce(text);
    });
  };

  /** The sentence still waiting to be heard, if any: an old one is never read again. */
  const unheard = () =>
    held.current || (!modal.current && performance.now() - saidAt.current < FRESH_MS)
      ? said.current
      : '';

  const say = (text: string) => {
    topic.current++;
    post(held.current ? join(said.current, text) : text);
  };

  /** Adds a sentence: with one not heard yet, else on its own. */
  const alsoSay = (text: string) => post(join(unheard(), text));

  const onModal = (open: boolean) => {
    modal.current = open;
    if (open || !held.current) return;
    held.current = false;
    post(said.current);
  };

  /**
   * After a deletion on this screen: a request that is gone leaves the open list at once, then the
   * list is loaded again silently (the deletion's outcome is what gets announced). A passing
   * failure keeps the rows and an open confirmation.
   */
  const reloadQuietly = async (gone: string | null) => {
    if (gone) {
      setList((old) =>
        old?.ok ? { ok: true, value: old.value.filter((x) => x.id !== gone) } : old,
      );
      setConfirming((c) => (c === gone ? null : c));
      setLost((l) => l.filter((x) => x.id !== gone));
    }
    const mine = ++listTurn.current;
    const v = await loadOpenSignups(api);
    if (!alive.current || mine !== listTurn.current) return;
    if (!v.ok && (v.error === 'network' || v.error === 'rate_limited') && listRef.current?.ok) {
      // Its own live region is inert behind a modal: then the sentence is held like the others.
      if (modal.current) alsoSay(t('console.signups.openStale'));
      return setOpenStale(true);
    }
    setOpenStale(false);
    keepUnconfirmed(v.ok, gone);
    setList(v);
    setMessages({});
    setConfirming((c) => (v.ok && v.value.some((x) => x.id === c) ? c : null));
  };

  /**
   * A list that loads settles what is unconfirmed. One that fails does not: what the rows about to
   * be replaced said stays in view above the problem text.
   */
  const keepUnconfirmed = (loaded: boolean, gone: string | null = null) => {
    if (loaded) return setLost([]);
    const rows = listRef.current?.ok ? listRef.current.value : [];
    const open = rows.filter(
      (x) => messagesRef.current[x.id]?.key === 'console.signups.err.not_found.unconfirmed',
    );
    // One line per request: a newer entry takes the place of an older one.
    setLost((old) =>
      [...new Map([...old, ...open].map(({ id, name }) => [id, { id, name }])).values()].filter(
        (x) => x.id !== gone,
      ),
    );
  };

  /**
   * The count line, followed by how many of the rows sit in the "not confirmed yet" group and how
   * many wait for the automatic approval. A row `acted` on here no longer shows that badge.
   */
  const countText = (rows: SignupRecord[], acted: (r: SignupRecord) => boolean) => {
    const c = signupCountView(rows, acted);
    let line = t(c.key, { count: c.count });
    const folded = rows.filter(isUnconfirmedRow).length;
    if (folded) line = join(line, t('console.signups.unconfirmed.counted', { count: folded }));
    return c.auto ? join(line, t(c.auto.key, { count: c.auto.count })) : line;
  };

  const reload = async () => {
    // The status is independent of the list: its failure shows its own message and never blocks it.
    spoken.current++;
    const turn = ++topic.current;
    const run = ++reloads.current;
    said.current = '';
    held.current = false;
    const mine = ++listTurn.current;
    clearTimeout(pendingTimer.current);
    setStatusPending(false);
    // Whether "checking" was shown and said: then a success is said too.
    let slow = false;
    pendingTimer.current = setTimeout(() => {
      slow = autoRef.current !== null;
      setStatusPending(true);
    }, PENDING_AFTER_MS);
    const status = loadAutoApproveStatus(statusApi).then((st) => {
      if (!alive.current) return st;
      // A superseded reload's late answer never overwrites the newer one's.
      if (run === reloads.current) {
        clearTimeout(pendingTimer.current);
        setStatusPending(false);
        setAutoStatus(st);
      }
      return st;
    });
    const v = await loadOpenSignups(api);
    if (!alive.current) return;
    // A quiet reload (after a deletion) may have overtaken this one: its list and count are then
    // dropped, but a status failure is still spoken.
    const current = mine === listTurn.current;
    if (current) {
      setOpenStale(false);
      keepUnconfirmed(v.ok);
      setList(v);
      setMessages({});
      setConfirming(null);
    }
    const unavailable = t('console.signups.auto.unavailable');
    const finished = t('console.signups.auto.checked');
    /** What was spoken last when the count went out; unset: no count was spoken. */
    let counted: number | undefined;
    if (current && v.ok) {
      // The loaded list drops every row message; only a row still being worked on differs.
      const count = countText(v.value, (r) => busyRef.current === r.id);
      // One announcement for both: a failed status is added to the count (a hung one is not waited for).
      const st = await Promise.race([
        status,
        new Promise<null>((r) => setTimeout(() => r(null), STATUS_WAIT_MS)),
      ]);
      if (!alive.current || run !== reloads.current) return;
      if (turn === topic.current) {
        const end = !st ? null : !st.ok ? unavailable : slow ? finished : null;
        const line = end ? join(count, end) : count;
        // A sentence added while this reload was pending (a stale list), not heard yet, stays,
        // after the count.
        const added = unheard();
        say(added ? join(line, added) : line);
        counted = spoken.current;
        if (st) return;
      }
    }
    // The status was not part of the count's announcement: a slow success ends the "checking" that
    // was said. Its failure is shown, so it is also spoken, unless a newer reload came first (also after a deliberate silence: that silences
    // the count and a sentence read by focus, not this one). It replaces only the count;
    // anything newer is kept and this is added to it.
    const late = await status;
    if (!alive.current || run !== reloads.current) return;
    if (late.ok) {
      if (slow) alsoSay(finished);
      return;
    }
    if (counted === spoken.current) say(unavailable);
    else alsoSay(unavailable);
  };
  useEffect(() => {
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
      clearTimeout(pendingTimer.current);
    };
  }, []);

  // Read while rendering, before the list in the page changes.
  const heldInRow = useRef<ReturnType<typeof focusedInRow>>(null);
  heldInRow.current = focusedInRow();

  // A reload may move the focused row between the two lists (its element is then a new one, and
  // focus drops to the page) or remove it. Focus returns to the same control of that row, else to
  // the row's primary one; a row now in the closed group opens it. A removed row: Refresh.
  useLayoutEffect(() => {
    const was = heldInRow.current;
    const at = document.activeElement;
    if (at?.closest('#signups-unconfirmed-rows[hidden]')) return setGroupOpen(true);
    // An action's own focus rules (below) win.
    if (!was || (at && at !== document.body)) return;
    if (focusId.current !== undefined || keptId.current !== null) return;
    const row = document.querySelector<HTMLElement>(`[data-signup-id="${CSS.escape(was.id)}"]`);
    if (!row) return refreshBtn.current?.focus();
    if (row.closest('[hidden]')) setGroupOpen(true);
    // After the group has opened: a hidden element cannot take focus.
    requestAnimationFrame(() => {
      const now = document.activeElement;
      if (now && now !== document.body) return;
      const same = was.act
        ? document.querySelector<HTMLElement>(
            `[data-signup-id="${CSS.escape(was.id)}"] [data-act="${was.act}"]`,
          )
        : null;
      (same ?? rowFocus(was.id) ?? refreshBtn.current)?.focus();
    });
  }, [list]);

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
        shown(
          document.querySelector<HTMLElement>(`[data-signup-id="${id}"] button[data-primary]`) ??
            document.querySelector<HTMLElement>(
              `[data-signup-id="${id}"] [data-testid="signup-message"]`,
            ),
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
    if (action === 'approve') approving.current.add(r.id);
    if (action === 'reject' || confirming === r.id) {
      // The confirm unmounts now; keep focus on the row while the request runs.
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLElement>(`[data-signup-id="${r.id}"] button[data-act="${action}"]`)
          ?.focus(),
      );
    }
    try {
      const o = await signupAction(api, r.id, action);
      if (!alive.current) return;
      // A definite account failure: nothing is left that could still add the account.
      if (o.kind === 'error' && (o.error === 'cap_reached' || o.error === 'account_error'))
        approving.current.delete(r.id);
      // With sign-up administration off the service answers `not_found` too: only a list that
      // loads shows that the request is really gone (a hung one is not waited for).
      let check: Loaded<SignupRecord[]> | null = null;
      let superseded = false;
      if (o.kind === 'error' && o.error === 'not_found') {
        const turn = listTurn.current;
        check = await Promise.race([
          loadOpenSignups(api),
          new Promise<null>((r) => setTimeout(() => r(null), STATUS_WAIT_MS)),
        ]);
        if (!alive.current) return;
        // A newer load, or the request's deletion here, tells more than this old answer.
        superseded =
          turn !== listTurn.current ||
          !(listRef.current?.ok && listRef.current.value.some((x) => x.id === r.id));
      }
      setStoredVersion((n) => n + 1);
      if (superseded) return;
      if (o.kind === 'error' && o.error === 'not_found' && !check?.ok) {
        const text = t('console.signups.err.not_found.unconfirmed', { name: isolate(r.name) });
        say(text);
        // Focus moves only if the person has not gone elsewhere meanwhile.
        const at = document.activeElement;
        const follow =
          !at || at === document.body || !!at.closest(`[data-signup-id="${CSS.escape(r.id)}"]`);
        if (check && !check.ok && check.error === 'unavailable') {
          // The whole list is replaced by its problem text; focus goes to Refresh.
          listTurn.current++;
          if (follow) focusId.current = null;
          // What other rows said stays in view too.
          keepUnconfirmed(false);
          setLost((old) => [...old.filter((x) => x.id !== r.id), { id: r.id, name: r.name }]);
          setList(check);
        } else {
          setMessages((m) => ({
            ...m,
            [r.id]: { key: 'console.signups.err.not_found.unconfirmed', ok: false },
          }));
          if (follow) {
            keptId.current = r.id;
            setKeptTick((n) => n + 1);
          }
        }
        return;
      }
      // The service answered about this request: it is no longer unconfirmed. A refused call
      // (no readable answer, signed out, ...) settles nothing.
      if (o.kind !== 'refused') setLost((l) => l.filter((x) => x.id !== r.id));
      const v = signupOutcomeView(o, action);
      const text = t(v.key as MessageKey, { name: isolate(r.name) });
      // The list as it is now: a request deleted meanwhile must not come back.
      const rows = listRef.current?.ok ? listRef.current.value : [];
      const present = rows.some((x) => x.id === r.id);
      // In reading order: the main list, then the group while it is open. A row in the closed
      // group is never a focus target; with none left, its toggle or Refresh takes focus.
      const from = present ? rows : list.value;
      const ids = [
        ...from.filter((x) => x.id === r.id || !isUnconfirmedRow(x)),
        ...from.filter((x) => x.id !== r.id && isUnconfirmedRow(x) && groupOpenRef.current),
      ].map((x) => x.id);
      if (isUnconfirmedRow(r) && groupOpenRef.current) {
        // The removed row was in the group: its neighbours there come first.
        ids.splice(0, ids.length, ...from.filter(isUnconfirmedRow).map((x) => x.id));
        if (ids.length === 1)
          ids.unshift(...from.filter((x) => !isUnconfirmedRow(x)).map((x) => x.id));
      }
      // A row that stays without an action gets focus on its outcome sentence, which is read on
      // focus: no live announcement then (it would be read twice). Every other outcome is spoken
      // by the live region (the row is gone, or focus is on a button).
      const messageFocused = present && !v.removed && signupRowKind(v.record ?? r) === 'queued';
      // This answer came in the background: focus moves only when its row is still listed and the
      // person has not gone elsewhere (focus is on the row, or nowhere because its control went).
      const at = document.activeElement;
      const follow =
        present &&
        (!at || at === document.body || !!at.closest(`[data-signup-id="${CSS.escape(r.id)}"]`));
      if (messageFocused && follow) {
        // Silence counts as an announcement: a pending one (e.g. the count) must not follow.
        topic.current++;
        spoken.current++;
        said.current = '';
        held.current = false;
        setAnnounce('');
      } else say(text);
      if (v.removed) {
        if (follow) focusId.current = focusAfterRemoval(ids, r.id);
        setList((old) =>
          old?.ok ? { ok: true, value: old.value.filter((x) => x.id !== r.id) } : old,
        );
      } else {
        if (v.record) {
          const rec = v.record;
          setList((old) =>
            old?.ok
              ? { ok: true, value: old.value.map((x) => (x.id === r.id ? keepState(rec, x) : x)) }
              : old,
          );
        }
        setMessages((m) => ({ ...m, [r.id]: { key: v.key as MessageKey, ok: v.ok } }));
        if (follow) {
          keptId.current = r.id;
          setKeptTick((n) => n + 1);
        }
      }
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const main = list?.ok ? list.value.filter((r) => !isUnconfirmedRow(r)) : [];
  const folded = list?.ok ? list.value.filter(isUnconfirmedRow) : [];
  const row = (r: SignupRecord) => {
    const working = busy === r.id;
    const msg = messages[r.id];
    const kind = signupRowKind(r);
    const name = isolate(r.name);
    const verifyKey = verificationKey(r, working || !!msg);
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
          <span class="badge badge-status" id={`signup-status-${r.id}`} data-testid="signup-status">
            {t(
              working
                ? 'console.signups.status.working'
                : (signupBadgeOverride(msg?.key) ?? signupStatusKey(r, !!msg)),
            )}
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
                      <bdi key={i} dir="auto">
                        {date(r.emailSendAfter!) ?? ''}
                      </bdi>,
                      part,
                    ],
              )}
          </div>
        )}
        {verifyKey && (
          <div class="small" data-testid="signup-verification">
            {t(verifyKey as MessageKey, { time: SLOT })
              .split(SLOT)
              .flatMap((part, i) =>
                i === 0
                  ? [part]
                  : [
                      <bdi key={i} dir="auto">
                        {date(r.verification!.sentAt!) ?? ''}
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
        {confirming === r.id && confirmAct === 'approve' && approveWarningKey(r) ? (
          <Confirm
            title={t('console.signups.confirmApprove.title', { name })}
            action={t('console.signups.confirmApprove.ok')}
            danger={false}
            busy={working}
            onCancel={() => {
              setConfirming(null);
              requestAnimationFrame(() =>
                document
                  .querySelector<HTMLElement>(
                    `[data-signup-id="${r.id}"] button[data-act="approve"]`,
                  )
                  ?.focus(),
              );
            }}
            onConfirm={() => void act(r, 'approve')}
          >
            <p data-testid="confirm-email">
              <bdi dir="ltr" class="code">
                {r.email}
              </bdi>
            </p>
            <p>{t(approveWarningKey(r) as MessageKey)}</p>
          </Confirm>
        ) : confirming === r.id && confirmAct === 'reject' ? (
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
                aria-describedby={`signup-status-${r.id}`}
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
                  onClick={() => {
                    if (!approveWarningKey(r)) return void act(r, 'approve');
                    if (busy) return;
                    setConfirmAct('approve');
                    setConfirming(r.id);
                  }}
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
                    onClick={() => {
                      if (busy) return;
                      setConfirmAct('reject');
                      setConfirming(r.id);
                    }}
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
  };
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
          onClick={() => {
            setStoredVersion((n) => n + 1);
            void reload();
          }}
        >
          {t('console.signups.refresh')}
        </button>
      </div>
      <div role="status" aria-live="polite" class="visually-hidden" data-testid="signups-live">
        {announce}
      </div>
      <AutoApproveBlock status={autoStatus} />
      {autoStatus?.ok && autoStatus.value.safeguards && (
        <SafeguardsBlock value={autoStatus.value.safeguards} />
      )}
      {/* A slow Refresh of that status is shown and said here; the region is always in the page
          (empty, it takes no room). The first load already says "Loading". */}
      <div role="status" class="notice-slot" data-testid="auto-pending-status">
        {statusPending && autoStatus && (
          <p class="muted small" data-testid="auto-pending">
            {t('console.signups.auto.checking')}
          </p>
        )}
      </div>
      {/* In the page before it has text; empty, it takes no room (styles.css). */}
      <div role="status" class="notice-slot" data-testid="signups-open-status">
        {openStale && (
          <p class="result warn" data-testid="signups-open-stale">
            {t('console.signups.openStale')}
          </p>
        )}
      </div>
      {list &&
        !list.ok &&
        lost.map((l) => (
          // Not a live region: the same sentence is already spoken above.
          <p key={l.id} class="result warn" data-testid="signups-unconfirmed">
            {t('console.signups.err.not_found.unconfirmed', { name: isolate(l.name) })}
          </p>
        ))}
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
            {countText(list.value, (r) => !!messages[r.id] || busy === r.id)}
          </p>
          {main.length > 0 && (
            <>
              <h2 class="visually-hidden" id="signups-list-h">
                {t('console.signups.list.heading')}
              </h2>
              <ul class="list" data-testid="signups-list" aria-labelledby="signups-list-h">
                {main.map(row)}
              </ul>
            </>
          )}
          {folded.length > 0 && (
            <section data-testid="signups-unconfirmed-group">
              <h2>
                <button
                  type="button"
                  class="button"
                  data-testid="signups-unconfirmed-toggle"
                  aria-expanded={groupOpen}
                  aria-controls="signups-unconfirmed-rows"
                  onClick={() => setGroupOpen((o) => !o)}
                >
                  <span aria-hidden="true">
                    {groupOpen ? '\u25BE ' : locale.dir === 'rtl' ? '\u25C2 ' : '\u25B8 '}
                  </span>
                  {t('console.signups.unconfirmed.heading', { count: folded.length })}
                </button>
              </h2>
              <ul class="list" id="signups-unconfirmed-rows" hidden={!groupOpen}>
                {folded.map(row)}
              </ul>
            </section>
          )}
        </>
      )}
      <StoredSignups
        say={say}
        alsoSay={alsoSay}
        onModal={onModal}
        version={storedVersion}
        approving={approving.current}
        onChanged={(gone) => void reloadQuietly(gone)}
      />
    </section>
  );
}

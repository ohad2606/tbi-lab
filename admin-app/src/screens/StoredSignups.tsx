import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import {
  deleteSignup,
  loadAllSignups,
  maskAddress,
  type Loaded,
  type SignupRecord,
} from '@tbi-lab/admin-client';
import { Loading, Problem } from '../common.js';
import { api, useConsole, useT } from '../context.js';
import { rescueFocus } from '../focus-rescue.js';
import type { MessageKey } from '../i18n.js';
import {
  deleteAccountWarning,
  deleteOutcomeView,
  filterByEmail,
  focusAfterRemoval,
  storedStatusKey,
} from '../views.js';

/** Inside an accessible name or a spoken sentence: a left-to-right isolate. */
const ltr = (s: string) => `⁦${s}⁩`;
/** How long typing in the filter rests before the number of matches is announced. */
const COUNT_WAIT_MS = 600;
/** How long a delete's announcement waits for the reload before the outcome is spoken alone. */
const RELOAD_WAIT_MS = 3000;

/** A translated sentence whose `{id}` / `{address}` sit in their own left-to-right <bdi>. */
function Sentence({ k, values }: { k: MessageKey; values: Record<string, string> }) {
  const t = useT();
  return (
    <>
      {t(k)
        .split(/(\{\w+\})/)
        .map((part, i) => {
          // Odd parts are the captured placeholders; plain text is never looked up.
          const v = i % 2 ? values[part.slice(1, -1)] : undefined;
          return v === undefined ? (
            part
          ) : (
            <bdi key={i} dir="ltr" class="code">
              {v}
            </bdi>
          );
        })}
    </>
  );
}

/**
 * The modal confirmation of one deletion (native modal dialog: the page behind it is inert).
 * Cancel takes focus; Escape cancels; Tab stays inside. `notice` is what changed after it opened:
 * the page's live region is inert behind the modal, so the dialog has its own.
 */
function DeleteDialog({
  children,
  notice,
  onModal,
  onCancel,
  onConfirm,
}: {
  children: ComponentChildren;
  notice: string;
  /** Told while the page behind is inert, so its announcements wait. */
  onModal: (open: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [spoken, setSpoken] = useState('');
  // A reload can remove the focused control (the Testers link goes with its warning): focus then
  // returns to Cancel, inside the dialog.
  useLayoutEffect(() => {
    if (dialog.current?.open && !dialog.current.contains(document.activeElement))
      cancel.current?.focus();
  });
  useEffect(() => {
    setSpoken('');
    const frame = requestAnimationFrame(() => setSpoken(notice));
    return () => cancelAnimationFrame(frame);
  }, [notice]);
  // A layout effect: the dialog is modal, with Cancel focused, in the same task as its render, so
  // a key pressed as soon as it appears (Escape) reaches it and not the page behind.
  useLayoutEffect(() => {
    dialog.current?.showModal();
    onModal(true);
    cancel.current?.focus();
    return () => onModal(false);
  }, []);
  return (
    <dialog
      ref={dialog}
      class="modal"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="delete-title"
      aria-describedby="delete-body"
      data-testid="delete-dialog"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      // The browser may close it on its own (a repeated Escape): that is a cancel too.
      onClose={onCancel}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
          return;
        }
        if (e.key !== 'Tab') return;
        const items = [...dialog.current!.querySelectorAll<HTMLElement>('a[href], button')];
        const i = items.indexOf(document.activeElement as HTMLElement);
        e.preventDefault();
        items[(i + (e.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
      }}
    >
      <h2 id="delete-title">{t('console.signups.delete.confirm.title')}</h2>
      <div id="delete-body" class="stack">
        {children}
      </div>
      <div role="status" class="visually-hidden" data-testid="delete-dialog-live">
        {spoken}
      </div>
      <div class="actions">
        <button
          ref={cancel}
          type="button"
          class="button"
          data-testid="delete-cancel"
          onClick={onCancel}
        >
          {t('admin.cancel')}
        </button>
        <button
          type="button"
          class="button button-danger"
          data-testid="delete-ok"
          // The second click of a double click on a row's Delete never confirms.
          onClick={(e) => e.detail < 2 && onConfirm()}
        >
          {t('console.signups.delete.confirm.ok')}
        </button>
      </div>
    </dialog>
  );
}

interface Outcome {
  id: string;
  key: MessageKey;
  gone: boolean;
  seconds?: number;
}

/**
 * K12: every stored request, to delete one person's request on demand. The list is loaded only
 * when opened, lives in memory only and is dropped when hidden; the filter is applied here and
 * never leaves the page. One request at a time, each after its own confirmation. Outcomes name
 * the request id only.
 */
export function StoredSignups({
  say,
  alsoSay,
  onModal,
  version,
  approving,
  onChanged,
}: {
  say: (text: string) => void;
  alsoSay: (text: string) => void;
  onModal: (open: boolean) => void;
  version: number;
  approving: ReadonlySet<string>;
  onChanged: (gone: string | null) => void;
}) {
  const t = useT();
  const { date, go } = useConsole();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Loaded<SignupRecord[]> | null>(null);
  const [stale, setStale] = useState(false);
  const [query, setQuery] = useState('');
  const [confirming, setConfirming] = useState<SignupRecord | null>(null);
  /** The open confirmation: whether it has shown an account warning, the one it opened with,
   * and whether that has changed since (a warning that comes back is then announced again). */
  const warned = useRef(false);
  const openedWith = useRef<ReturnType<typeof deleteAccountWarning>>(null);
  const changed = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const listRef = useRef(list);
  listRef.current = list;
  const inFlight = useRef(false);
  /** Counts deletes: a late list settles only the newest one's sentence. */
  const deletes = useRef(0);
  const turn = useRef(0);
  const section = useRef<HTMLElement>(null);
  /** Whether the latest focus on the page was inside this section. */
  const focusedHere = useRef(false);
  useEffect(() => {
    const track = (e: FocusEvent) => {
      focusedHere.current = !!section.current?.contains(e.target as Node);
    };
    document.addEventListener('focusin', track);
    return () => document.removeEventListener('focusin', track);
  }, []);
  /** Takes a lost focus's place: only focus that was in this section stays in it. */
  const successor = () => (focusedHere.current ? (filter.current ?? toggle.current) : null);
  const toggle = useRef<HTMLButtonElement>(null);
  const filter = useRef<HTMLInputElement>(null);
  const countTimer = useRef<ReturnType<typeof setTimeout>>();
  /** Where focus goes once the reloaded list is on screen: these rows' Delete, in order. */
  const focusNext = useRef<(string | null)[] | null>(null);
  const [focusTick, setFocusTick] = useState(0);

  const deleteButton = (id: string) =>
    document.querySelector<HTMLElement>(`[data-stored-id="${CSS.escape(id)}"] button`);

  const countText = (rows: SignupRecord[], q: string) =>
    t('console.signups.all.count', { shown: filterByEmail(rows, q).length, total: rows.length });

  /**
   * The list from the server. A passing failure keeps the rows already shown, marked stale.
   * null: a newer load (or hiding the list) overtook this one.
   */
  const load = async () => {
    const mine = ++turn.current;
    const v = await loadAllSignups(api);
    if (mine !== turn.current) return null;
    const passing = !v.ok && (v.error === 'network' || v.error === 'rate_limited');
    setList((old) => (passing && old?.ok ? old : v));
    setStale(passing);
    return { v, stale: passing && !!listRef.current?.ok };
  };

  useEffect(() => {
    if (open)
      void load().then((r) => {
        if (r?.stale) alsoSay(t('console.signups.all.stale'));
        // The reloaded list may no longer hold the row that has focus.
        rescueFocus(successor);
      });
  }, [version]);
  useEffect(
    () => () => {
      turn.current++;
      clearTimeout(countTimer.current);
    },
    [],
  );

  useEffect(() => {
    const targets = focusNext.current;
    if (!targets) return;
    focusNext.current = null;
    const found = targets.map((id) => (id ? deleteButton(id) : null)).find(Boolean);
    (found ?? filter.current ?? toggle.current)?.focus();
  }, [focusTick]);

  // The confirmation never outlives its row: a reload that fails for good, or no longer holds the
  // request, closes it, says why and moves focus to the filter, else the show/hide button.
  useEffect(() => {
    if (!confirming || !list) return;
    const { id } = confirming;
    if (!list.ok) {
      say(
        list.error === 'unavailable'
          ? t('console.signups.all.unavailable')
          : t(`admin.error.${list.error}`),
      );
    } else if (!list.value.some((x) => x.id === id)) {
      const key: MessageKey = 'console.signups.delete.gone';
      setOutcome({ id, key, gone: true });
      say(t(key, { id: ltr(id) }));
      onChanged(id);
    } else return;
    setConfirming(null);
    focusNext.current = [];
    setFocusTick((n) => n + 1);
  }, [list]);

  const show = async () => {
    if (open) {
      turn.current++;
      deletes.current++;
      clearTimeout(countTimer.current);
      setOpen(false);
      setList(null);
      setQuery('');
      setOutcome(null);
      setStale(false);
      return;
    }
    setOpen(true);
    const r = await load();
    if (r?.v.ok) say(countText(r.v.value, ''));
  };

  const type = (q: string) => {
    setQuery(q);
    clearTimeout(countTimer.current);
    if (list?.ok) {
      const rows = list.value;
      countTimer.current = setTimeout(() => say(countText(rows, q)), COUNT_WAIT_MS);
    }
  };

  /** Opens the confirmation and reloads the list, so its warnings are current. */
  const ask = (r: SignupRecord) => {
    if (inFlight.current) return;
    warned.current = false;
    changed.current = false;
    openedWith.current = deleteAccountWarning(r, approving);
    setConfirming(r);
    void load();
  };

  const cancel = () => {
    const id = confirming?.id;
    setConfirming(null);
    if (id) requestAnimationFrame(() => deleteButton(id)?.focus());
  };

  const remove = async (r: SignupRecord) => {
    // A ref, not state: a second activation in the same tick must not send a second request.
    if (inFlight.current || !list?.ok) return;
    inFlight.current = true;
    const mine = ++deletes.current;
    clearTimeout(countTimer.current);
    const ids = filterByEmail(list.value, query).map((x) => x.id);
    setConfirming(null);
    setBusy(r.id);
    setOutcome(null);
    say(t('console.signups.delete.working'));
    requestAnimationFrame(() => deleteButton(r.id)?.focus());
    try {
      const answer = await deleteSignup(api, r.id);
      // With sign-up administration off the service answers `not_found` too: only the reloaded
      // list tells that apart from a request that is gone, so nothing is claimed before it.
      const unsure = answer.kind === 'not_found';
      const view = (reload?: 'listed' | 'off' | 'unconfirmed') => {
        const v = deleteOutcomeView(answer, reload);
        const done: Outcome = { ...v, id: r.id, key: v.key as MessageKey };
        return { v, done, text: t(done.key, { id: ltr(r.id), seconds: v.seconds ?? '' }) };
      };
      let { v, done, text } = view();
      if (!unsure) onChanged(v.gone ? r.id : null);
      // One announcement for the outcome and a failed reload. A slow reload is not waited for:
      // after the bound the row is released; without a list a `not_found` stays unconfirmed.
      const reload = load();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const first = await Promise.race([
        reload,
        new Promise<'slow'>((done) => (timer = setTimeout(done, RELOAD_WAIT_MS, 'slow'))),
      ]);
      clearTimeout(timer);
      const next = first === 'slow' ? null : first;
      if (unsure) {
        const got = next?.v;
        ({ v, done, text } = view(
          !got
            ? 'unconfirmed'
            : got.ok
              ? 'listed'
              : got.error === 'unavailable'
                ? 'off'
                : 'unconfirmed',
        ));
        onChanged(v.gone ? r.id : null);
      }
      const stale = next?.stale ? t('console.signups.all.stale') : '';
      say(stale ? `${text} ${stale}` : text);
      setOutcome(done);
      if (first === 'slow')
        void reload.then((late) => {
          if (late?.stale) alsoSay(t('console.signups.all.stale'));
          // The list that arrives after all settles an "unconfirmed" outcome, unless a newer
          // delete (or hiding the list) came first.
          if (unsure && late && mine === deletes.current) {
            const got = late.v;
            const settled = view(
              got.ok ? 'listed' : got.error === 'unavailable' ? 'off' : 'unconfirmed',
            );
            if (settled.done.key !== done.key) {
              say(settled.text);
              setOutcome(settled.done);
              onChanged(settled.v.gone ? r.id : null);
              if (settled.v.gone) drop();
            }
          }
          // A late list may no longer hold the row that has focus.
          rescueFocus(successor);
        });
      // Gone on the server: never keep showing it, even when the reload failed.
      const drop = () =>
        setList((old) =>
          old?.ok ? { ok: true, value: old.value.filter((x) => x.id !== r.id) } : old,
        );
      if (v.gone) drop();
      // Move focus only if the person has not moved elsewhere meanwhile.
      const at = document.activeElement;
      if (!at || at === document.body || at.closest(`[data-stored-id="${CSS.escape(r.id)}"]`)) {
        const after = focusAfterRemoval(ids, r.id);
        const before = ids[ids.indexOf(r.id) - 1] ?? null;
        // An unconfirmed row is kept, with its outcome: focus stays on it.
        const kept = !v.gone && (unsure || next?.v.ok !== false);
        focusNext.current = kept ? [r.id, after, before] : [after, before];
        setFocusTick((n) => n + 1);
      }
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  const rows = list?.ok ? filterByEmail(list.value, query) : [];
  const retained = !!outcome && !outcome.gone && rows.some((r) => r.id === outcome.id);
  const result = outcome && (
    <p
      class={`result ${outcome.gone ? 'ok' : 'warn'}`}
      data-testid="delete-result"
      data-key={outcome.key}
    >
      <Sentence
        k={outcome.key}
        values={{ id: outcome.id, seconds: String(outcome.seconds ?? '') }}
      />
    </p>
  );
  // The dialog follows a reload that arrives while it is open.
  const target =
    confirming && ((list?.ok && list.value.find((x) => x.id === confirming.id)) || confirming);
  const warning = target && deleteAccountWarning(target, approving);
  if (warning) warned.current = true;
  if (confirming && warning !== openedWith.current) changed.current = true;
  const notice = [
    warning && confirming && changed.current ? t(`console.signups.delete.confirm.${warning}`) : '',
    // A warning that was on screen and is gone is said once; no warning at all says nothing.
    confirming && !warning && warned.current ? t('console.signups.delete.confirm.noWarning') : '',
    stale ? t('console.signups.all.stale') : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <section ref={section} aria-labelledby="stored-h" class="stack" data-testid="stored-signups">
      <h2 id="stored-h">{t('console.signups.all.heading')}</h2>
      <p class="muted">{t('console.signups.all.intro')}</p>
      <div class="actions">
        <button
          ref={toggle}
          type="button"
          class="button"
          data-testid="stored-toggle"
          aria-expanded={open ? 'true' : 'false'}
          aria-disabled={busy ? 'true' : undefined}
          // Never hidden while a delete runs: its reload would keep the list in memory.
          onClick={() => !inFlight.current && void show()}
        >
          {t(open ? 'console.signups.all.hide' : 'console.signups.all.show')}
        </button>
      </div>
      {open &&
        (!list ? (
          <Loading />
        ) : !list.ok ? (
          <>
            {result}
            <Problem
              error={list.error}
              unavailable="console.signups.all.unavailable"
              testid="stored-problem"
            />
          </>
        ) : (
          <>
            <label class="field">
              <span>{t('console.signups.all.filter')}</span>
              {/* No autocomplete or spell check: the address typed stays in this page. */}
              <input
                ref={filter}
                type="search"
                dir="ltr"
                autocomplete="off"
                autocapitalize="off"
                spellcheck={false}
                data-testid="stored-filter"
                value={query}
                onInput={(e) => type(e.currentTarget.value)}
              />
            </label>
            {!retained && result}
            {stale && (
              <p class="result warn" data-testid="stored-stale">
                {t('console.signups.all.stale')}
              </p>
            )}
            <p class="muted small" data-testid="stored-count">
              {countText(list.value, query)}
            </p>
            {rows.length === 0 ? (
              <p class="muted" data-testid="stored-empty">
                {t(list.value.length ? 'console.signups.all.noMatch' : 'console.signups.all.none')}
              </p>
            ) : (
              <ul class="list" data-testid="stored-list">
                {rows.map((r) => (
                  <li key={r.id} class="item" data-testid="stored-row" data-stored-id={r.id}>
                    <div class="item-head">
                      <bdi dir="ltr" class="code" data-testid="stored-email">
                        {r.email}
                      </bdi>
                      <span class="badge">{t(storedStatusKey(r.status) as MessageKey)}</span>
                      {r.accountAdded && (
                        <span class="badge badge-auto" data-testid="stored-account">
                          {t('console.signups.all.accountAdded')}
                        </span>
                      )}
                    </div>
                    <div>
                      <bdi dir="auto">{r.name}</bdi>
                    </div>
                    <div class="small">
                      {t('console.signups.all.id')}:{' '}
                      <bdi dir="ltr" class="code">
                        {r.id}
                      </bdi>
                    </div>
                    <div class="muted small">
                      {t('console.signups.requested', { time: date(r.createdAt) ?? '' })}
                    </div>
                    {retained && outcome!.id === r.id && result}
                    <div class="actions">
                      <button
                        type="button"
                        class="button button-danger"
                        data-testid="stored-delete"
                        // The name holds the visible text in both states (2.5.3).
                        aria-label={
                          busy === r.id
                            ? `${t('console.signups.delete.working')} ${ltr(r.id)}`
                            : t('console.signups.delete.for', {
                                id: ltr(r.id),
                                address: ltr(maskAddress(r.email)),
                              })
                        }
                        aria-disabled={busy ? 'true' : undefined}
                        onClick={() => ask(r)}
                      >
                        {t(
                          busy === r.id
                            ? 'console.signups.delete.working'
                            : 'console.signups.delete',
                        )}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        ))}
      {target && (
        <DeleteDialog
          notice={notice}
          onModal={onModal}
          onCancel={cancel}
          onConfirm={() => void remove(target)}
        >
          <p>
            <Sentence
              k="console.signups.delete.confirm.target"
              values={{ id: target.id, address: maskAddress(target.email) }}
            />
          </p>
          <p>{t('console.signups.delete.confirm.body')}</p>
          {warning && (
            <>
              <p class="result warn" data-testid="delete-warning" data-warning={warning}>
                {t(`console.signups.delete.confirm.${warning}`)}
              </p>
              <a
                class="more"
                href="#/testers"
                data-testid="delete-testers"
                onClick={(e) => {
                  e.preventDefault();
                  setConfirming(null);
                  go({ name: 'testers' });
                }}
              >
                {t('console.signups.delete.confirm.testers')}
              </a>
            </>
          )}
        </DeleteDialog>
      )}
    </section>
  );
}

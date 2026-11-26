import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  deleteSignup,
  loadAllSignups,
  maskAddress,
  type Loaded,
  type SignupRecord,
} from '@tbi-lab/admin-client';
import { Loading, Problem } from '../common.js';
import { api, useConsole, useT } from '../context.js';
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
 * Cancel takes focus; Escape cancels; Tab stays inside.
 */
function DeleteDialog({
  children,
  onCancel,
  onConfirm,
}: {
  children: ComponentChildren;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    cancel.current?.focus();
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
  version,
  approving,
  onChanged,
}: {
  say: (text: string) => void;
  version: number;
  approving: ReadonlySet<string>;
  onChanged: () => void;
}) {
  const t = useT();
  const { date, go } = useConsole();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Loaded<SignupRecord[]> | null>(null);
  const [stale, setStale] = useState(false);
  const [query, setQuery] = useState('');
  const [confirming, setConfirming] = useState<SignupRecord | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const inFlight = useRef(false);
  const turn = useRef(0);
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

  /** The list from the server. A passing failure keeps the rows already shown, marked stale. */
  const load = async (): Promise<Loaded<SignupRecord[]> | null> => {
    const mine = ++turn.current;
    const v = await loadAllSignups(api);
    if (mine !== turn.current) return null;
    const passing = !v.ok && (v.error === 'network' || v.error === 'rate_limited');
    setList((old) => (passing && old?.ok ? old : v));
    setStale(passing);
    return v;
  };

  useEffect(() => {
    if (open) void load();
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

  const show = async () => {
    if (open) {
      turn.current++;
      clearTimeout(countTimer.current);
      setOpen(false);
      setList(null);
      setQuery('');
      setOutcome(null);
      setStale(false);
      return;
    }
    setOpen(true);
    const v = await load();
    if (v?.ok) say(countText(v.value, ''));
  };

  const type = (q: string) => {
    setQuery(q);
    clearTimeout(countTimer.current);
    if (list?.ok) {
      const rows = list.value;
      countTimer.current = setTimeout(() => say(countText(rows, q)), COUNT_WAIT_MS);
    }
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
    clearTimeout(countTimer.current);
    const ids = filterByEmail(list.value, query).map((x) => x.id);
    setConfirming(null);
    setBusy(r.id);
    setOutcome(null);
    say(t('console.signups.delete.working'));
    requestAnimationFrame(() => deleteButton(r.id)?.focus());
    try {
      const v = deleteOutcomeView(await deleteSignup(api, r.id));
      const done: Outcome = { ...v, id: r.id, key: v.key as MessageKey };
      say(t(done.key, { id: ltr(r.id), seconds: v.seconds ?? '' }));
      onChanged();
      const next = await load();
      setOutcome(done);
      // Gone on the server: never keep showing it, even when the reload failed.
      if (v.gone)
        setList((old) =>
          old?.ok ? { ok: true, value: old.value.filter((x) => x.id !== r.id) } : old,
        );
      // Move focus only if the person has not moved elsewhere meanwhile.
      const at = document.activeElement;
      if (!at || at === document.body || at.closest(`[data-stored-id="${r.id}"]`)) {
        const after = focusAfterRemoval(ids, r.id);
        const before = ids[ids.indexOf(r.id) - 1] ?? null;
        focusNext.current = !v.gone && next?.ok !== false ? [r.id, after, before] : [after, before];
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

  return (
    <section aria-labelledby="stored-h" class="stack" data-testid="stored-signups">
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
                        onClick={() => !inFlight.current && setConfirming(r)}
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
        <DeleteDialog onCancel={cancel} onConfirm={() => void remove(target)}>
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

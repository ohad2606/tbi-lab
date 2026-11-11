import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  DISPLAY_NAME_MAX,
  israelTime,
  loadAccounts,
  loadAudit,
  loadCapacity,
  loadReports,
  loadUsage,
  requestResult,
  type MutationOutcome,
} from '@tbi-lab/admin-client';
import { SIGN_IN_URL, SIGN_OUT_URL, Loading } from './common.js';
import { ConsoleContext, api, type Console, type Data, type MutationAction } from './context.js';
import { getLocale, storeLocale, storedLocale, translate, type MessageKey } from './i18n.js';
import { parseRoute, routeHash, section, type Route } from './views.js';
import { Activity } from './screens/Activity.js';
import { Add } from './screens/Add.js';
import { Feedback, Report } from './screens/Feedback.js';
import { Settings } from './screens/Settings.js';
import { TesterDetail, Testers } from './screens/Testers.js';
import { Today } from './screens/Today.js';

const SECTIONS = ['today', 'testers', 'add', 'feedback', 'activity', 'settings'] as const;
const SEEN_KEY = 'tbi-admin.seenReports';
/** A pending request is checked this often, this many times; then on request only. */
const POLL_MS = 1500;
const POLL_TRIES = 40;

function loadSeen(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}
function storeSeen(seen: Set<string>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-1000)));
  } catch {
    // per device and best effort: the list then simply shows everything as new
  }
}

const EMPTY: Data = { accounts: null, capacity: null, usage: null, reports: null, audit: null };

export function App() {
  const [locale, setLocaleState] = useState(storedLocale);
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  const [data, setData] = useState<Data>(EMPTY);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    id: string;
    label: string;
    action: MutationAction;
    tries: number;
  } | null>(null);
  const [seen, setSeen] = useState(loadSeen);
  const main = useRef<HTMLElement>(null);
  const t = (key: MessageKey, params?: Record<string, string | number>) =>
    translate(locale, key, params);

  useEffect(() => {
    document.documentElement.lang = locale.code;
    document.documentElement.dir = locale.dir;
  }, [locale]);

  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash));
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);

  // A new screen: its heading takes focus (screen readers hear where they are), at the top.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const h = main.current?.querySelector<HTMLElement>('h1');
    if (h) {
      h.tabIndex = -1;
      h.focus({ preventScroll: true });
    }
    scrollTo(0, 0);
  }, [routeHash(route)]);

  const refresh = async (parts: (keyof Data)[] = Object.keys(EMPTY) as (keyof Data)[]) => {
    const loaders = {
      accounts: () => loadAccounts(api),
      capacity: () => loadCapacity(api),
      usage: () => loadUsage(api),
      reports: () => loadReports(api),
      audit: () => loadAudit(api, 500),
    } as const;
    await Promise.all(
      parts.map(async (k) => {
        const v = await loaders[k]();
        setData((d) => ({ ...d, [k]: v }));
      }),
    );
  };
  useEffect(() => void refresh(), []);

  // The Lab's wording for every outcome (shared texts).
  const outcomeText = (o: MutationOutcome, label: string, action: MutationAction): string => {
    if (o.kind === 'pending') return t('admin.result.pending', { id: o.id });
    if (o.kind === 'refused')
      return o.error === 'invalid_email'
        ? t('admin.add.invalid')
        : o.error === 'invalid_name'
          ? t('admin.name.invalid', { max: DISPLAY_NAME_MAX })
          : t(
              `admin.error.${o.error === 'invalid' || o.error === 'csrf' ? 'network' : o.error}` as MessageKey,
            );
    if (o.code === 'forbidden' && o.ownerPending) return t('admin.result.ownerPending');
    const key = o.code === 'done' ? `admin.result.done.${action}` : `admin.result.${o.code}`;
    return t(key as MessageKey, { account: label || o.masked || '***' });
  };

  const settle = async (o: MutationOutcome, label: string, action: MutationAction) => {
    setNotice(outcomeText(o, label, action));
    if (o.kind === 'pending') setPending({ id: o.id, label, action, tries: 0 });
    else await refresh(['accounts', 'capacity', 'audit']);
  };

  const checkPending = async () => {
    if (!pending) return;
    const o = await requestResult(api, pending.id);
    if (o.kind === 'pending') {
      setPending((p) => (p && p.id === pending.id ? { ...p, tries: p.tries + 1 } : p));
      return;
    }
    setPending(null);
    setNotice(outcomeText(o, pending.label, pending.action));
    await refresh(['accounts', 'capacity', 'audit']);
  };
  // 202: the helper has not answered yet; ask again on its own for a while.
  useEffect(() => {
    if (!pending || pending.tries >= POLL_TRIES) return;
    const timer = setTimeout(() => void checkPending(), POLL_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  const ctx: Console = useMemo(
    () => ({
      locale,
      setLocale: (code: string) => {
        storeLocale(code);
        setLocaleState(getLocale(code));
      },
      route,
      go: (r: Route) => {
        if (location.hash !== routeHash(r)) location.hash = routeHash(r);
        else setRoute(r);
      },
      data,
      refresh,
      settle,
      notice,
      setNotice,
      seen,
      markSeen: (id: string) =>
        setSeen((s) => {
          if (s.has(id)) return s;
          const next = new Set(s).add(id);
          storeSeen(next);
          return next;
        }),
      date: (iso, withTime = true) => israelTime(iso, locale.code, withTime),
    }),
    [locale, route, data, notice, seen, pending],
  );

  // Who may use the app is the servers' decision: no sign-in, or not the owner, shows only that.
  const loads = Object.values(data) as Data[keyof Data][];
  const signedOut = loads.some((l) => l && !l.ok && l.error === 'signed_out');
  const forbidden = loads.some((l) => l && !l.ok && l.error === 'forbidden');
  let body;
  if (signedOut || forbidden)
    body = (
      <main class="access" data-testid={signedOut ? 'access-signed-out' : 'access-forbidden'}>
        <img src="/icon-192.png" alt="" width={96} height={96} />
        <h1>
          {t(signedOut ? 'console.access.signedOut.title' : 'console.access.forbidden.title')}
        </h1>
        <p>{t(signedOut ? 'console.access.signedOut.text' : 'console.access.forbidden.text')}</p>
        {signedOut ? (
          <a class="button button-primary" href={SIGN_IN_URL} data-testid="sign-in-link">
            {t('console.access.signIn')}
          </a>
        ) : (
          <a class="button" href={SIGN_OUT_URL} data-testid="sign-out-link">
            {t('console.access.signOut')}
          </a>
        )}
      </main>
    );
  else if (!data.accounts)
    body = (
      <main class="access">
        <Loading />
      </main>
    );
  else {
    const current = section(route);
    body = (
      <div class="shell">
        <a class="skip" href="#main" onClick={(e) => (e.preventDefault(), main.current?.focus())}>
          {t('console.skip')}
        </a>
        <header class="top">
          <a
            class="brand"
            href="#/today"
            onClick={(e) => {
              e.preventDefault();
              ctx.go({ name: 'today' });
            }}
          >
            <img src="/icon-192.png" alt="" width={32} height={32} />
            <span>{t('console.appName')}</span>
          </a>
          <button type="button" class="button" data-testid="refresh" onClick={() => void refresh()}>
            {t('console.refresh')}
          </button>
        </header>
        <nav class="nav" aria-label={t('console.nav.label')}>
          <ul>
            {SECTIONS.map((s) => (
              <li key={s}>
                <a
                  href={`#/${s}`}
                  aria-current={current === s ? 'page' : undefined}
                  data-testid={`nav-${s}`}
                  onClick={(e) => {
                    e.preventDefault();
                    setNotice(null);
                    ctx.go({ name: s });
                  }}
                >
                  {t(`console.nav.${s}`)}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <main id="main" ref={main} tabIndex={-1} class="main">
          <div role="status" aria-live="polite" class="notice-region">
            {notice && (
              <p class="notice" data-testid="notice">
                {notice}
                {pending && (
                  <>
                    {' '}
                    {pending.tries < POLL_TRIES && (
                      <span class="muted">{t('console.tester.checking')}</span>
                    )}{' '}
                    <button
                      type="button"
                      class="button"
                      data-testid="pending-check"
                      onClick={() => void checkPending()}
                    >
                      {t('admin.add.checkAgain')}
                    </button>
                  </>
                )}
              </p>
            )}
          </div>
          {route.name === 'today' && <Today />}
          {route.name === 'testers' && <Testers />}
          {route.name === 'tester' && <TesterDetail key={route.target} target={route.target} />}
          {route.name === 'add' && <Add />}
          {route.name === 'feedback' && <Feedback />}
          {route.name === 'report' && <Report key={route.id} id={route.id} />}
          {route.name === 'activity' && <Activity />}
          {route.name === 'settings' && <Settings />}
        </main>
      </div>
    );
  }
  return <ConsoleContext.Provider value={ctx}>{body}</ConsoleContext.Provider>;
}

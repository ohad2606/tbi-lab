import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type {
  AccountsView,
  AuditView,
  Capacity,
  Loaded,
  MutationOutcome,
  ReportMeta,
  UsageView,
} from '@tbi-lab/admin-client';
import { translate, type LocaleInfo, type MessageKey, type Params } from './i18n.js';
import type { Route } from './views.js';

/** The API's fetch: relative, same-origin (the shared client adds the rest). */
export const api = (input: string, init?: RequestInit) => fetch(input, init);

export type MutationAction = 'add' | 'disable' | 'reactivate' | 'rename';

export interface Data {
  accounts: Loaded<AccountsView> | null;
  capacity: Loaded<Capacity> | null;
  usage: Loaded<UsageView> | null;
  reports: Loaded<ReportMeta[]> | null;
  audit: Loaded<AuditView> | null;
}

export interface Console {
  locale: LocaleInfo;
  setLocale: (code: string) => void;
  route: Route;
  go: (r: Route) => void;
  data: Data;
  /** Reload everything (or the named parts). */
  refresh: (parts?: (keyof Data)[]) => Promise<void>;
  /** Report a mutation's outcome; a pending request is then checked automatically. */
  settle: (o: MutationOutcome, label: string, action: MutationAction) => Promise<void>;
  notice: string | null;
  setNotice: (n: string | null) => void;
  seen: ReadonlySet<string>;
  markSeen: (id: string) => void;
  /** Israel time, in the UI language. */
  date: (iso: string | null, withTime?: boolean) => string | null;
}

export const ConsoleContext = createContext<Console | null>(null);

export function useConsole(): Console {
  const c = useContext(ConsoleContext);
  if (!c) throw new Error('ConsoleContext missing');
  return c;
}

export function useT() {
  const { locale } = useConsole();
  return (key: MessageKey, params?: Params) => translate(locale, key, params);
}

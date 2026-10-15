/**
 * In-app problem reports (Sprint 14): the request contract shared by the app and the Session
 * Host. Pure (no I/O), like protocol.ts.
 *
 *   POST /reports   body: ProblemReportRequest (JSON, at most MAX_REPORT_BYTES)
 *                   -> 201 { id }   only once the report is durably stored
 *
 * The client sends what the tester wrote and chose, plus a few facts about the app it is running
 * (version, interface language, the simulation status it shows). Everything else in a stored
 * report comes from the host: the principal (from the gate, never from the body), the time, the
 * host's own release, the browser family (from User-Agent; the full string is never kept) and the
 * session's authoritative status. A body naming any other field is refused, so a client can never
 * assert an identity, an owner or diagnostics.
 */

export const REPORT_CATEGORIES = ['simulation', 'build', 'editor', 'other'] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

/** Where the tester was (the app's screens; no project or view content). */
export const REPORT_VIEWS = ['home', 'editor'] as const;
export type ReportView = (typeof REPORT_VIEWS)[number];

/** The app's simulation status as the tester saw it (client-reported; labelled as such). */
export const REPORT_SIM_STATUSES = [
  'stopped',
  'starting',
  'running',
  'stopping',
  'failed',
] as const;
export type ReportSimStatus = (typeof REPORT_SIM_STATUSES)[number];

/** Largest accepted request body. A full-length description is about 4 KiB of UTF-8 at most. */
export const MAX_REPORT_BYTES = 8 * 1024;
/** Description length in Unicode code points, after normalization. */
export const MAX_DESCRIPTION_CHARS = 1000;

/** Report ids: 12 Crockford base32 characters in three groups (60 random bits), e.g. 7K3M-9QX2-WDAB. */
export const REPORT_ID_RE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

export interface ProblemReportRequest {
  description: string;
  category: ReportCategory;
  blocking: boolean;
  /** BCP 47 language tag of the interface (e.g. `en`, `he`). */
  locale: string;
  view: ReportView;
  /** The app build the tester runs (BUILD_INFO), when it has one. */
  app?: { version: string; commit: string };
  /** The tester's current or most recent ESP32 session; associated only if it is theirs. */
  sessionId?: string;
  /** The simulation status the app shows, and its failure code if any. */
  sim?: { status: ReportSimStatus; code?: string };
}

type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(o).every((k) => keys.includes(k));
const oneOf = <T extends string>(v: unknown, list: readonly T[]): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v);

const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;
const VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const SESSION_RE = /^[0-9a-f]{32}$/;
const CODE_RE = /^[a-z0-9_]{1,48}$/;

// C0 and C1 controls except tab and line feed (a carriage return becomes a line feed first).
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * The description as stored: NFC, line breaks as `\n`, control characters removed (tab and line
 * feed kept), malformed UTF-16 replaced, surrounding whitespace trimmed. The words themselves are
 * never changed: user-authored text is kept as written, in any language and direction.
 */
export function cleanDescription(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(CONTROLS, '')
    .replace(LONE_SURROGATE, '�')
    .normalize('NFC')
    .trim();
}

/** Length in Unicode code points (what the app's counter shows and the limit counts). */
export const codePoints = (text: string): number => [...text].length;

export function validateReport(v: unknown): Validation<ProblemReportRequest> {
  const bad = (error: string): Validation<ProblemReportRequest> => ({ ok: false, error });
  if (!isObj(v)) return bad('body must be an object');
  if (
    !onlyKeys(v, [
      'description',
      'category',
      'blocking',
      'locale',
      'view',
      'app',
      'sessionId',
      'sim',
    ])
  )
    return bad('unknown field');
  if (typeof v.description !== 'string') return bad('description');
  const description = cleanDescription(v.description);
  if (description === '') return bad('description empty');
  if (codePoints(description) > MAX_DESCRIPTION_CHARS) return bad('description too long');
  if (!oneOf(v.category, REPORT_CATEGORIES)) return bad('category');
  if (typeof v.blocking !== 'boolean') return bad('blocking');
  if (typeof v.locale !== 'string' || !LOCALE_RE.test(v.locale)) return bad('locale');
  if (!oneOf(v.view, REPORT_VIEWS)) return bad('view');
  const out: ProblemReportRequest = {
    description,
    category: v.category,
    blocking: v.blocking,
    locale: v.locale,
    view: v.view,
  };
  if (v.app !== undefined) {
    const a = v.app;
    if (!isObj(a) || !onlyKeys(a, ['version', 'commit'])) return bad('app');
    if (typeof a.version !== 'string' || !VERSION_RE.test(a.version)) return bad('app.version');
    if (typeof a.commit !== 'string' || !COMMIT_RE.test(a.commit)) return bad('app.commit');
    out.app = { version: a.version, commit: a.commit };
  }
  if (v.sessionId !== undefined) {
    if (typeof v.sessionId !== 'string' || !SESSION_RE.test(v.sessionId)) return bad('sessionId');
    out.sessionId = v.sessionId;
  }
  if (v.sim !== undefined) {
    const s = v.sim;
    if (!isObj(s) || !onlyKeys(s, ['status', 'code'])) return bad('sim');
    if (!oneOf(s.status, REPORT_SIM_STATUSES)) return bad('sim.status');
    if (s.code !== undefined && (typeof s.code !== 'string' || !CODE_RE.test(s.code)))
      return bad('sim.code');
    out.sim = { status: s.status, ...(s.code !== undefined ? { code: s.code } : {}) };
  }
  return { ok: true, value: out };
}

export interface BrowserInfo {
  family: 'Chrome' | 'Edge' | 'Firefox' | 'Safari' | 'Opera' | 'Other';
  major: number | null;
  os: 'Windows' | 'macOS' | 'Linux' | 'ChromeOS' | 'Android' | 'iOS' | 'Other';
}

/**
 * Browser family, major version and operating-system family from a User-Agent header. Only these
 * three bounded values are kept; the header itself is never stored or logged.
 */
export function browserOf(userAgent: string | undefined): BrowserInfo {
  const ua = (userAgent ?? '').slice(0, 512);
  const major = (re: RegExp) => {
    const m = re.exec(ua);
    return m ? Math.min(Number(m[1]), 9999) : null;
  };
  let family: BrowserInfo['family'] = 'Other';
  let version: number | null = null;
  // Order matters: Edge and Opera also announce Chrome; Chrome also announces Safari.
  for (const [name, re] of [
    ['Edge', /\bEdg(?:e|A|iOS)?\/(\d{1,5})/],
    ['Opera', /\bOPR\/(\d{1,5})/],
    ['Firefox', /\b(?:Firefox|FxiOS)\/(\d{1,5})/],
    ['Chrome', /\b(?:Chrome|CriOS|HeadlessChrome)\/(\d{1,5})/],
    ['Safari', /\bVersion\/(\d{1,5})[^ ]* (?:Mobile\/\S+ )?Safari\//],
  ] as const) {
    version = major(re);
    if (version !== null) {
      family = name;
      break;
    }
  }
  const os: BrowserInfo['os'] = /Windows NT/.test(ua)
    ? 'Windows'
    : /CrOS/.test(ua)
      ? 'ChromeOS'
      : /Android/.test(ua)
        ? 'Android'
        : /iPhone|iPad|iPod/.test(ua)
          ? 'iOS'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'macOS'
            : /Linux|X11/.test(ua)
              ? 'Linux'
              : 'Other';
  return { family, major: version, os };
}

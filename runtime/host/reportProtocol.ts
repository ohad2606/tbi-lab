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

/**
 * Sprint 23B: what kind of feedback this is. `bug` is the RC4 problem report (its `category` is
 * the area); for every other kind the category is `other`. A request without `kind` is a bug
 * report, exactly as an RC4 client sends it.
 */
export const REPORT_KINDS = ['bug', 'component', 'feature', 'general'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** Device class of the tester's screen (from the app; never a model or a fingerprint). */
export const REPORT_DEVICES = ['desktop', 'tablet', 'other'] as const;
export type ReportDevice = (typeof REPORT_DEVICES)[number];

/** A requested component's name, in code points (kind `component` only; optional). */
export const MAX_COMPONENT_NAME_CHARS = 80;

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
  /** Sprint 23B: the kind of feedback (absent: `bug`, as RC4). */
  kind?: ReportKind;
  /** Sprint 23B: the name of a requested component (kind `component` only). */
  component?: string;
  /**
   * Sprint 23B: optional technical context the tester agreed to include. Data minimization: the
   * runtime version the app talks to, the device class and the open project's id; never the
   * project's contents, names or logs.
   */
  context?: { runtime?: string; device?: ReportDevice; projectId?: string };
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
const PROJECT_RE = /^prj_[A-Za-z0-9]{1,64}$/;

// C0 and C1 controls except tab and line feed (a carriage return becomes a line feed first).
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
/**
 * Sprint 23B (review I3): bidirectional embedding, override and isolate controls (U+202A–U+202E,
 * U+2066–U+2069). They are invisible and can reorder what an owner or operator reads (a report's
 * text, a component name); they are removed. Ordinary right-to-left text needs none of them.
 */
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * The description as stored: NFC, line breaks as `\n`, control characters and bidi embedding /
 * override / isolate controls removed (tab and line feed kept), malformed UTF-16 replaced, surrounding whitespace trimmed. The words themselves are
 * never changed: user-authored text is kept as written, in any language and direction.
 */
export function cleanDescription(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(CONTROLS, '')
    .replace(BIDI_CONTROLS, '')
    .replace(LONE_SURROGATE, '�')
    .normalize('NFC')
    .trim();
}

/** A component name as stored: the description's cleaning, on one line, spaces collapsed. */
export function cleanComponentName(text: string): string {
  return cleanDescription(text).replace(/\s+/g, ' ');
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
      'kind',
      'component',
      'context',
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
  if (v.kind !== undefined) {
    if (!oneOf(v.kind, REPORT_KINDS)) return bad('kind');
    out.kind = v.kind;
  }
  // Only a bug report names an area; every other kind is filed under `other`.
  if ((out.kind ?? 'bug') !== 'bug' && out.category !== 'other') return bad('category');
  if (v.component !== undefined) {
    if (out.kind !== 'component' || typeof v.component !== 'string') return bad('component');
    const name = cleanComponentName(v.component);
    if (codePoints(name) > MAX_COMPONENT_NAME_CHARS) return bad('component too long');
    if (name !== '') out.component = name;
  }
  if (v.context !== undefined) {
    const c = v.context;
    if (!isObj(c) || !onlyKeys(c, ['runtime', 'device', 'projectId'])) return bad('context');
    const ctx: NonNullable<ProblemReportRequest['context']> = {};
    if (c.runtime !== undefined) {
      if (typeof c.runtime !== 'string' || !VERSION_RE.test(c.runtime))
        return bad('context.runtime');
      ctx.runtime = c.runtime;
    }
    if (c.device !== undefined) {
      if (!oneOf(c.device, REPORT_DEVICES)) return bad('context.device');
      ctx.device = c.device;
    }
    if (c.projectId !== undefined) {
      if (typeof c.projectId !== 'string' || !PROJECT_RE.test(c.projectId))
        return bad('context.projectId');
      ctx.projectId = c.projectId;
    }
    out.context = ctx;
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

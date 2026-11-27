/**
 * "What is sent" guard: every field of a problem report (what the app posts, and what the host
 * adds to the stored record) is named in the dialog's disclosure, in English and Hebrew.
 *
 * Adding a field fails here twice: the tables below are typed by the contract's keys
 * (`npm run typecheck`), and the produced request and stored record are compared with them.
 * Disclose the new field in both message bundles, then add it to a table.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GLOSSARY, applyGlossary } from '../src/i18n/glossary.js';
import { en } from '../src/i18n/messages.en.js';
import { he } from '../src/i18n/messages.he.js';
import {
  DISCLOSURE_ALWAYS,
  DISCLOSURE_SERVER,
  buildRequest,
  emptyDraft,
  type ReportDraft,
} from '../src/ui/problemReport.js';
import type { ProblemReportRequest, BrowserInfo } from '../../runtime/host/reportProtocol.js';
import { DEFAULT_REPORTS, ReportStore, type StoredReport } from '../../runtime/host/reports.js';
import { emptyView } from '../src/runtime/view.js';

const text = { en: applyGlossary(en, GLOSSARY.en!), he: applyGlossary(he, GLOSSARY.he!) };

type Key =
  | (typeof DISCLOSURE_ALWAYS)[number]
  | (typeof DISCLOSURE_SERVER)[number]
  | 'report.disclosure.context';
/** Where a field is disclosed: the message and the words in it that name the field. */
type Told = { key: Key; en: string; he: string };
const told = (key: Key, enWords: string, heWords: string): Told => ({
  key,
  en: enWords,
  he: heWords,
});
const TEXT = 'report.disclosure.item.text';
const APP = 'report.disclosure.item.app';
const SIM = 'report.disclosure.item.sim';
const BROWSER = 'report.disclosure.item.browser';
const SERVER = 'report.disclosure.item.account';
const RUN = 'report.disclosure.item.run';
const CONTEXT = 'report.disclosure.context';

type Sub<K extends 'app' | 'sim' | 'context'> = keyof NonNullable<ProblemReportRequest[K]> & string;
type RequestPath =
  | Exclude<keyof ProblemReportRequest, 'app' | 'sim' | 'context'>
  | `app.${Sub<'app'>}`
  | `sim.${Sub<'sim'>}`
  | `context.${Sub<'context'>}`;

/** Every field the app can post. */
const SENT: Record<RequestPath, Told> = {
  description: told(TEXT, 'your text', 'הטקסט שכתבתם'),
  kind: told(TEXT, 'type of report', 'סוג הדיווח'),
  category: told(TEXT, 'the area', 'התחום'),
  blocking: told(TEXT, 'whether it blocks you', 'האם הבעיה חוסמת אתכם'),
  component: told(TEXT, 'component name', 'שם הרכיב'),
  locale: told(APP, 'interface language', 'שפת הממשק'),
  view: told(APP, 'screen you are on', 'המסך שבו אתם נמצאים'),
  'app.version': told(APP, 'app version', 'גרסת האפליקציה'),
  'app.commit': told(APP, 'build identifier', 'מזהה הבנייה'),
  'sim.status': told(SIM, 'simulation status', 'מצב הסימולציה'),
  'sim.code': told(SIM, 'error code', 'קוד השגיאה'),
  sessionId: told(SIM, 'run ID', 'מזהה ההרצה'),
  'context.runtime': told(CONTEXT, 'runtime version', 'גרסת סביבת הריצה'),
  'context.device': told(CONTEXT, 'device type (desktop, tablet or other)', 'מחשב, טאבלט או אחר'),
  'context.projectId': told(CONTEXT, 'open project’s ID', 'מזהה הפרויקט הפתוח'),
};

const ACCOUNT = told(SERVER, 'identifies the account', 'שמזהה את החשבון');
const RELEASE = told(SERVER, 'server version', 'גרסת השרת');
const BROWSER_NAME = told(BROWSER, 'browser name', 'שם הדפדפן');

/** Stored fields that come from the request (disclosed above). */
type FromRequest =
  | 'category'
  | 'blocking'
  | 'description'
  | 'locale'
  | 'view'
  | 'app'
  | 'appSim'
  | 'kind'
  | 'component'
  | 'context';
/** What the host adds (`v` is the file format's version, not information about the tester). */
const ADDED: Record<
  Exclude<keyof StoredReport, FromRequest | 'v' | 'session' | 'browser'>,
  Told
> = {
  id: told(SERVER, 'report ID', 'מזהה לדיווח'),
  receivedAt: told(SERVER, 'time it was received', 'מועד הקבלה'),
  principal: ACCOUNT,
  release: RELEASE,
};
const BROWSER_FIELDS: Record<keyof BrowserInfo, Told> = {
  family: BROWSER_NAME,
  major: told(BROWSER, 'major version', 'מספר הגרסה הראשי'),
  os: told(BROWSER, 'operating system', 'מערכת ההפעלה'),
};
const SESSION: Record<keyof NonNullable<StoredReport['session']>, Told> = {
  id: SENT.sessionId,
  state: told(RUN, 'state', 'מצבה'),
  reason: told(RUN, 'why it ended', 'סיבת הסיום'),
  outcome: told(RUN, 'outcome', 'התוצאה'),
  ageS: told(RUN, 'how long ago it was created', 'כמה זמן עבר מאז שנוצרה'),
  endedAgoS: told(RUN, 'how long ago it ended', 'כמה זמן עבר מאז שהסתיימה'),
  simS: told(RUN, 'simulated time', 'הזמן המדומה'),
};

const draft = (over: Partial<ReportDraft>): ReportDraft => ({
  ...emptyDraft(),
  description: 'The LED never lights.',
  category: 'build',
  blocking: true,
  ...over,
});
/** Every optional input present: a failed ESP32 run with the editor open. */
const full = (d: ReportDraft) =>
  buildRequest(d, {
    locale: 'he',
    view: 'editor',
    build: {
      product: 'TBI Lab',
      version: '1.0.0',
      environment: 'alpha',
      commit: 'c'.repeat(40),
      shortCommit: 'c'.repeat(7),
      builtAt: '2026-10-15T00:00:00Z',
      dirty: false,
    },
    sim: {
      status: 'failed',
      failure: { kind: 'runtime', code: 'runtime_crashed' },
      runtime: {
        ...emptyView('board.esp32_devkitc_wroom32', 'f'.repeat(64)),
        sessionId: 'a'.repeat(32),
      },
    },
    runtimeVersion: '1.0.0',
    device: 'desktop',
    projectId: 'prj_abc',
  });

const NESTED = ['app', 'sim', 'context'];
const paths = (r: ProblemReportRequest): string[] =>
  Object.entries(r).flatMap(([k, v]) =>
    NESTED.includes(k) ? Object.keys(v as object).map((s) => `${k}.${s}`) : [k],
  );

describe('problem report disclosure', () => {
  it('names every field the app can post: no more, no less', () => {
    const all = new Set([
      ...paths(full(draft({ kind: 'bug' }))),
      ...paths(full(draft({ kind: 'component', component: 'KY-040' }))),
    ]);
    expect([...all].sort()).toEqual(Object.keys(SENT).sort());
  });

  it('technical details are on by default; only they are optional', () => {
    expect(emptyDraft().includeContext).toBe(true);
    const without = paths(full(draft({ includeContext: false })));
    // The run id and the error code do not depend on the checkbox.
    expect(without).toEqual(expect.arrayContaining(['sessionId', 'sim.status', 'sim.code']));
    expect(without.filter((p) => SENT[p as RequestPath].key === CONTEXT)).toEqual([]);
    const added = paths(full(draft({}))).filter((p) => !without.includes(p));
    expect(added.map((p) => SENT[p as RequestPath].key)).toEqual([CONTEXT, CONTEXT, CONTEXT]);
    expect(text.en[CONTEXT]).toContain('checked by default');
    expect(text.he[CONTEXT]).toContain('מסומן כברירת מחדל');
  });

  it('names every field the host stores', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tbi-disclosure-'));
    try {
      const store = new ReportStore({ ...DEFAULT_REPORTS, dir }, { log: () => undefined });
      const now = new Date().toISOString();
      const out = await store.submit(
        full(draft({})),
        'p_0123456789abcdef' as StoredReport['principal'],
        'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0.0.0 Safari/537.36',
        {
          statusFor: () => ({
            state: 'ended',
            reason: null,
            createdAt: now,
            endedAt: now,
            simNs: '1000000',
            runtime: { outcome: null } as never,
          }),
        },
      );
      if (!('status' in out) || out.status !== 201) throw new Error('not stored');
      const record = JSON.parse(
        await readFile(join(dir, `${out.body.id}.json`), 'utf8'),
      ) as StoredReport;
      const fromRequest: FromRequest[] = [
        'category',
        'blocking',
        'description',
        'locale',
        'view',
        'app',
        'appSim',
        'kind',
        'component',
        'context',
      ];
      expect(Object.keys(record).sort()).toEqual(
        [...fromRequest, ...Object.keys(ADDED), 'v', 'session', 'browser'].sort(),
      );
      expect(Object.keys(record.session!).sort()).toEqual(Object.keys(SESSION).sort());
      expect(Object.keys(record.browser).sort()).toEqual(Object.keys(BROWSER_FIELDS).sort());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  for (const lang of ['en', 'he'] as const)
    it(`${lang}: the words for each field are in a message the dialog shows`, () => {
      const shown: string[] = [...DISCLOSURE_ALWAYS, ...DISCLOSURE_SERVER, CONTEXT];
      for (const [field, t] of [
        ...Object.entries(SENT),
        ...Object.entries(ADDED),
        ...Object.entries(BROWSER_FIELDS),
        ...Object.entries(SESSION),
      ]) {
        expect(shown, field).toContain(t.key);
        expect(text[lang][t.key].toLowerCase(), field).toContain(t[lang].toLowerCase());
      }
    });
});

/**
 * TBI-017 slice 1: the AI explanation in the Circuit Debugger (DEV-Lab build on :4175), against a
 * MOCK AI service: Playwright route interception of /assist/v1/* in each test's own browser
 * context. No real provider, no network beyond the local preview server.
 *
 * - Flag off by default: no service / disabled service = findings-only mode, one sentence why,
 *   announced once; no Ask button; nothing POSTed.
 * - Keyboard-only path: open, Ask, consent dialog (focus on its heading, not on Agree), preview,
 *   Esc = nothing sent, Agree = one request with the consent, answer, withdraw consent.
 * - Nothing is sent on open, on analysing, on cancelling the dialog or on a language change.
 * - Fixed layout: simulator findings (with "comes from the simulation, not AI") before the AI
 *   section, which carries the "AI-generated, may be wrong" label in text.
 * - Polite status once per transition (re-announced when repeated), role=alert for errors,
 *   Cancel while sending, focus never lost. EN and HE (RTL, LTR technical tokens), 320 px.
 */
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
} from '@playwright/test';
import { createPackage, serializePackage, type ProjectDocument } from '@tbi-lab/domain';
import { EXPLAIN_CONTRACT, diagnose, type EngineeringContext } from '@tbi-lab/assist';
import { ledLoop } from '../../packages/assist/eval/bench.js';
import { goToProjects, reopenFromLibrary, waitSaved } from './helpers.js';

// The DEV-Lab preview (playwright.app.config.ts); overridable when that port is taken.
const DEV = process.env.TBI_E2E_DEV_URL ?? 'http://127.0.0.1:4175';
const LRI = '⁦';

interface MockOptions {
  status?: Record<string, unknown> | 'none';
  /** Explain answer: 'ok', an error body + HTTP status, or 'hang' (until the browser aborts). */
  explain?: 'ok' | 'hang' | { status: number; body: Record<string, unknown> };
  delayMs?: number;
  previewDelayMs?: number;
  /** The Nth /status call (1-based) is never answered (until the browser aborts). */
  statusHangOn?: number;
}

const STATUS = (over: Record<string, unknown> = {}) => ({
  protocol: 'tbi-lab.assist-service/1',
  state: 'active',
  mode: 'live',
  provider: 'mockprov',
  model: 'mock-model-1',
  pilot: true,
  consentVersion: '2026-11-22',
  limits: { perMinute: 6, perDay: 50, timeoutMs: 20000, maxOutputTokens: 800 },
  data: {
    sent: ['instructions', 'locale', 'findings', 'circuit', 'checks_and_results'],
    neverSent: ['identity', 'project_name', 'net_names', 'serial_output'],
    auditRetentionDays: 30,
  },
  ...over,
});

class MockService {
  readonly calls: { method: string; path: string; body: unknown }[] = [];
  constructor(public opts: MockOptions) {}
  posts(path?: string) {
    return this.calls.filter((c) => c.method === 'POST' && (!path || c.path === path));
  }
  async handle(route: Route) {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace('/assist/v1', '');
    const body = req.postData() ? (JSON.parse(req.postData()!) as unknown) : null;
    this.calls.push({ method: req.method(), path, body });
    const json = (status: number, b: unknown) =>
      route
        .fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) })
        .catch(() => undefined);
    if (path === '/status') {
      if (this.calls.filter((c) => c.path === '/status').length === this.opts.statusHangOn) return;
      if (this.opts.status === 'none') return json(404, { error: 'not_found' });
      return json(200, this.opts.status ?? STATUS());
    }
    const ctx = (body as { context: EngineeringContext }).context;
    if (path === '/preview') {
      await new Promise((r) => setTimeout(r, this.opts.previewDelayMs ?? 0));
      return json(200, {
        payload: { system: 'SYSTEM TEXT', user: JSON.stringify({ circuit: ctx.circuit }) },
        bytes: 1234,
        estimatedInputTokens: 309,
      });
    }
    if (path === '/explain') {
      const e = this.opts.explain ?? 'ok';
      if (e === 'hang') return; // never answered: the browser's abort ends it
      await new Promise((r) => setTimeout(r, this.opts.delayMs ?? 600));
      if (e !== 'ok') return json(e.status, e.body);
      const findings = diagnose(ctx);
      return json(200, {
        findings,
        response: {
          contract: EXPLAIN_CONTRACT,
          explanations: findings.map((f) => ({
            finding: f.key,
            text: `Mock AI text about ${f.id}.`,
            cites: f.evidence.slice(0, 1),
          })),
        },
        unexplained: [],
        accounting: {
          provider: 'mockprov',
          model: 'mock-model-1',
          live: true,
          attempts: 1,
          inputTokens: 300,
          outputTokens: 50,
          estimatedTokens: false,
          costUsd: 0.0012,
          latencyMs: 600,
        },
      });
    }
    return json(404, { error: 'not_found' });
  }
}

async function setup(browser: Browser, opts: MockOptions, viewport = { width: 1400, height: 860 }) {
  const context = await browser.newContext({ viewport });
  const svc = new MockService(opts);
  await context.route('**/assist/v1/**', (r) => svc.handle(r));
  const page = await context.newPage();
  await openDev(page, { ...ledLoop(5, 0.1, null).doc, name: 'AI assistant spec' });
  return { context, page, svc };
}

async function openDev(page: Page, doc: ProjectDocument) {
  const text = serializePackage(
    createPackage(doc, { appVersion: '0.1.0', exportedAt: '2026-11-01T00:00:00.000Z' }),
  );
  await page.goto(DEV);
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId('import-file').setInputFiles({
    name: 'fixture.tbilab',
    mimeType: 'application/json',
    buffer: Buffer.from(text, 'utf8'),
  });
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
}

/** The same project in a new tab of the same browser context (shared localStorage only). */
async function openInNewTab(context: BrowserContext) {
  const tab = await context.newPage();
  await tab.goto(DEV);
  const library = tab.getByTestId('example-list');
  await expect(library.or(tab.getByTestId('canvas'))).toBeVisible();
  if (await library.isVisible()) await reopenFromLibrary(tab);
  return tab;
}

/** Tab (forward) until the element with this test id has focus: proves it is reachable. */
async function tabTo(page: Page, testId: string, max = 25) {
  for (let i = 0; i < max; i++) {
    if (
      await page.evaluate(
        (id) => document.activeElement?.getAttribute('data-testid') === id,
        testId,
      )
    )
      return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`${testId} not reached by Tab`);
}

async function openPanelByKeyboard(page: Page) {
  await page.getByTestId('assist-open').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#assist-title')).toBeFocused();
}

const live = (page: Page) => page.getByTestId('assist-live');
/** Remembered consent keys in both storages (without an account: session only). */
const consentKeys = (page: Page) =>
  page.evaluate(() => {
    const of = (s: Storage) => Object.keys(s).filter((k) => k.includes('tbi-lab.assist.consent'));
    return [
      ...of(localStorage).map((k) => `local:${k}`),
      ...of(sessionStorage).map((k) => `session:${k}`),
    ];
  });
const SESSION_KEY = 'tbi-lab.assist.consent/session/2026-11-22';
const seedSessionConsent = (page: Page) =>
  page.evaluate(
    (k) =>
      sessionStorage.setItem(k, JSON.stringify({ accepted: true, at: '2026-11-22T00:00:00.000Z' })),
    SESSION_KEY,
  );

async function close(context: BrowserContext) {
  await context.close();
}

test.describe.configure({ mode: 'serial' });

test('EN keyboard-only: consent dialog, preview, Esc sends nothing, Agree sends once, withdraw', async ({
  browser,
}) => {
  const { context, page, svc } = await setup(browser, { previewDelayMs: 700 });
  await openPanelByKeyboard(page);
  // Opening asks only for the status (a GET): nothing about the project is sent.
  await expect(page.getByTestId('ai-ask')).toHaveText('Explain this circuit');
  expect(svc.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /status']);

  await tabTo(page, 'ai-ask');
  await page.keyboard.press('Enter');
  const dialog = page.getByTestId('ai-consent');
  await expect(dialog).toBeVisible();
  // Default focus: the dialog's heading (the safe place), not "Agree and send".
  await expect(page.locator('#ai-consent-h')).toBeFocused();
  await expect(dialog).toHaveAttribute('aria-labelledby', 'ai-consent-h');
  await expect(page.getByRole('dialog', { name: 'Send this circuit to the AI?' })).toBeVisible();
  await expect(page.getByTestId('ai-consent-sent').locator('li')).toHaveCount(5);
  await expect(page.getByTestId('ai-consent-never')).toContainText('the project name');
  await expect(page.getByTestId('ai-consent-model')).toContainText('mock-model-1');
  await expect(page.getByTestId('ai-consent-version')).toContainText(`${LRI}2026-11-22`);
  // The local analysis ran (findings are shown behind the dialog); still nothing was POSTed.
  expect(svc.posts()).toHaveLength(0);

  // Preview by keyboard: "Loading" in the status while it loads, then the exact payload in a
  // named, focusable LTR region; still no explain request.
  await tabTo(page, 'ai-preview');
  await page.keyboard.press('Enter');
  const previewStatus = page.getByTestId('ai-preview-status');
  await expect(previewStatus).toHaveAttribute('role', 'status');
  await expect(previewStatus).toHaveText('Loading the preview…');
  await expect(page.getByTestId('ai-preview')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('ai-payload')).toContainText('SYSTEM TEXT');
  await expect(page.getByTestId('ai-payload')).toHaveAttribute('dir', 'ltr');
  const region = page.getByRole('region', { name: 'Exactly what would be sent' });
  await expect(region).toHaveAttribute('data-testid', 'ai-payload');
  await region.focus();
  await expect(region).toBeFocused();
  await expect(previewStatus).toContainText('What would be sent is shown below');
  await expect(previewStatus).toContainText('Nothing has been sent to the AI provider.');
  expect(svc.posts('/explain')).toHaveLength(0);

  // Esc = Cancel: nothing sent, the panel stays open, focus back on Ask, announced.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('assist-panel')).toBeVisible();
  await expect(page.getByTestId('ai-ask')).toBeFocused();
  await expect(live(page)).toHaveText('Nothing was sent.');
  expect(svc.posts('/explain')).toHaveLength(0);
  expect(await consentKeys(page)).toEqual([]);

  // Again; the same message repeats when cancelled with the Cancel button (re-announced).
  await page.keyboard.press('Enter');
  await expect(page.locator('#ai-consent-h')).toBeFocused();
  await tabTo(page, 'ai-consent-cancel');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('ai-ask')).toBeFocused();
  await expect(live(page)).toHaveText('Nothing was sent.');

  // Agree and send.
  await page.keyboard.press('Enter');
  await tabTo(page, 'ai-consent-agree');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('ai-sending')).toHaveText('Asking the AI…');
  await expect(live(page)).toHaveText('Asking the AI…');
  await expect(page.getByTestId('ai-cancel')).toBeVisible();
  await expect(page.getByTestId('ai-result')).toHaveAttribute('data-state', 'success');
  await expect(live(page)).toHaveText(/^Answer ready\. Findings explained: \d+\.$/);
  await expect(page.getByTestId('ai-ask')).toBeFocused();
  await expect(page.getByTestId('ai-ask')).toHaveText('Explain again');

  // Exactly one explain request, with exactly the documented keys and the consent.
  const sent = svc.posts('/explain');
  expect(sent).toHaveLength(1);
  const body = sent[0]!.body as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(['consent', 'context', 'contract', 'locale']);
  expect(body.consent).toEqual({ version: '2026-11-22', accepted: true });
  expect(body.locale).toBe('en');
  expect(JSON.stringify(body)).not.toContain('AI assistant spec'); // no project name

  // Fixed layout: findings first (DOM and visual order), then the labelled AI section.
  const findings = page.getByTestId('assist-findings');
  const ai = page.getByTestId('ai-result');
  await expect(page.getByTestId('assist-findings-note')).toContainText(
    'These come from the simulation, not from AI.',
  );
  await expect(page.getByTestId('ai-label')).toHaveText(
    'AI-generated, may be wrong. Check it against the simulator findings above.',
  );
  expect(
    await page.evaluate(() => {
      const f = document.querySelector('[data-testid="assist-findings"]')!;
      const a = document.querySelector('[data-testid="ai-result"]')!;
      return !!(f.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING);
    }),
  ).toBe(true);
  expect((await findings.boundingBox())!.y).toBeLessThan((await ai.boundingBox())!.y);
  await expect(page.getByTestId('assist-explanation-section')).toHaveCount(0); // template off
  await expect(page.getByTestId('ai-answer')).toHaveAttribute('data-same-findings', 'true');
  await expect(page.getByTestId('assist-explanation').first()).toContainText('Mock AI text');
  await expect(page.getByTestId('assist-accounting')).toContainText('mock-model-1');

  // No account from the service: remembered for this browser session only (never localStorage);
  // the next Ask sends without the dialog.
  expect(await consentKeys(page)).toEqual([`session:${SESSION_KEY}`]);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('ai-result')).toHaveAttribute('data-state', 'success');
  await expect(dialog).toBeHidden();
  expect(svc.posts('/explain')).toHaveLength(2);

  // A language change sends nothing.
  await page.getByTestId('language-select').selectOption('he');
  await page.getByTestId('language-select').selectOption('en');
  await page.waitForTimeout(300);
  expect(svc.posts()).toHaveLength(3); // 1 preview + 2 explain

  // Withdraw consent by keyboard: cleared, announced, focus to Ask; the next Ask asks again.
  await tabTo(page, 'ai-withdraw');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('ai-withdraw')).toHaveCount(0);
  await expect(page.getByTestId('ai-ask')).toBeFocused();
  await expect(live(page)).toHaveText(
    'Consent withdrawn. You will be asked again before anything is sent.',
  );
  expect(await consentKeys(page)).toEqual([]);
  await page.keyboard.press('Enter');
  await expect(page.locator('#ai-consent-h')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('ai-consent')).toBeHidden();
  await expect(page.getByTestId('ai-ask')).toBeFocused();

  // Esc closes the panel (no dialog open); focus returns to the top-bar button.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('assist-panel')).toHaveCount(0);
  await expect(page.getByTestId('assist-open')).toBeFocused();
  await close(context);
});

test('sending: Cancel aborts, is announced politely, focus stays usable, no alert', async ({
  browser,
}) => {
  const { context, page, svc } = await setup(browser, { explain: 'hang' });
  await seedSessionConsent(page);
  await openPanelByKeyboard(page);
  await tabTo(page, 'ai-ask');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('ai-cancel')).toBeVisible();
  // While sending, Ask stays in place (no focus loss) but does nothing.
  await expect(page.getByTestId('ai-ask')).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Enter');
  expect(svc.posts('/explain')).toHaveLength(1);
  // The live region joins messages that follow each other within ~120 ms (by design): wait until
  // the "sending" message has been delivered, so the cancel message is a separate announcement.
  await expect(live(page)).toHaveText('Asking the AI…');
  await tabTo(page, 'ai-cancel');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('ai-cancel')).toHaveCount(0);
  await expect(page.getByTestId('ai-ask')).toBeFocused();
  await expect(live(page)).toHaveText(
    'The request was cancelled. The simulator findings are unchanged.',
  );
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByTestId('assist-findings')).toBeVisible();
  await close(context);
});

test('errors: role=alert with text and retry; limits that do not clear get no retry; retry after wait', async ({
  browser,
}) => {
  const { context, page, svc } = await setup(browser, {
    explain: { status: 502, body: { error: 'provider_error' } },
    delayMs: 50,
  });
  await seedSessionConsent(page);
  await page.getByTestId('assist-open').click();
  await page.getByTestId('ai-ask').click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('The AI provider failed to answer.');
  await expect(alert).toContainText('The simulator findings above are unaffected.');
  await expect(page.getByTestId('ai-ask')).toHaveText('Try again');
  await expect(page.getByTestId('assist-findings')).toBeVisible();
  // The same error again: a new alert element (so it is announced again).
  const first = await alert.elementHandle();
  await page.getByTestId('ai-ask').click();
  await expect.poll(async () => svc.posts('/explain').length).toBe(2);
  await expect(alert).toHaveCount(1);
  await expect.poll(async () => (await alert.elementHandle()) !== first).toBe(true);
  // A limit: no "Try again".
  svc.opts.explain = { status: 429, body: { error: 'daily_limit' } };
  await page.getByTestId('ai-ask').click();
  await expect(page.getByTestId('ai-error')).toHaveAttribute('data-error', 'daily_limit');
  await expect(page.getByTestId('ai-ask')).toHaveText('Explain this circuit');
  // rate_limited: the wait is shown in seconds, Ask is unavailable until it passes.
  svc.opts.explain = { status: 429, body: { error: 'rate_limited', retryAfterMs: 1500 } };
  await page.getByTestId('ai-ask').click();
  await expect(page.getByTestId('ai-error')).toContainText(`try again in ${LRI}2`);
  await expect(page.getByTestId('ai-ask')).toHaveAttribute('aria-disabled', 'true');
  // (A keyboard press: Playwright's click itself would wait for aria-disabled to clear.)
  await page.getByTestId('ai-ask').focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  expect(svc.posts('/explain')).toHaveLength(4);
  await expect(page.getByTestId('ai-ask')).not.toHaveAttribute('aria-disabled', 'true', {
    timeout: 4000,
  });
  // consent_required with the same version: the remembered consent is dropped, the status is
  // asked again, and (no new version) the error is shown, not a dialog loop.
  svc.opts.explain = { status: 428, body: { error: 'consent_required' } };
  const gets = () => svc.calls.filter((c) => c.path === '/status').length;
  expect(gets()).toBe(1);
  await page.getByTestId('ai-ask').click();
  await expect(page.getByTestId('ai-error')).toHaveAttribute('data-error', 'consent_required');
  expect(gets()).toBe(2);
  expect(await consentKeys(page)).toEqual([]);
  await close(context);
});

test('consent_required: the status is asked again; the dialog reopens only with the fresh version and lists', async ({
  browser,
}) => {
  const { context, page, svc } = await setup(browser, {
    explain: { status: 428, body: { error: 'consent_required' } },
    delayMs: 50,
  });
  await seedSessionConsent(page);
  await openPanelByKeyboard(page);
  // The service moved to a new version with another data list.
  svc.opts.status = STATUS({
    consentVersion: '2026-12-01',
    data: { sent: ['instructions', 'circuit'], neverSent: ['identity'], auditRetentionDays: 14 },
  });
  await tabTo(page, 'ai-ask');
  await page.keyboard.press('Enter');
  await expect(page.locator('#ai-consent-h')).toBeFocused();
  await expect(page.getByTestId('ai-consent-version')).toContainText('2026-12-01');
  await expect(page.getByTestId('ai-consent-sent').locator('li')).toHaveCount(2);
  await expect(page.getByTestId('ai-consent-never').locator('li')).toHaveCount(1);
  expect(svc.calls.filter((c) => c.path === '/status')).toHaveLength(2);
  expect(await consentKeys(page)).toEqual([]);
  // Agreeing now sends the fresh version. That one is refused too and the service is now off:
  // "not available" (no dialog), announced, focus on the panel heading (never lost).
  svc.opts.status = 'none';
  await tabTo(page, 'ai-consent-agree');
  await page.keyboard.press('Enter');
  await expect.poll(() => svc.posts('/explain').length).toBe(2);
  expect((svc.posts('/explain')[1]!.body as { consent: unknown }).consent).toEqual({
    version: '2026-12-01',
    accepted: true,
  });
  await expect(page.getByTestId('ai-not-available')).toHaveAttribute('data-reason', 'unavailable');
  await expect(page.locator('#assist-title')).toBeFocused();
  expect(svc.calls.filter((c) => c.path === '/status')).toHaveLength(3);
  await expect(page.getByTestId('ai-ask')).toHaveCount(0);
  await expect(page.getByTestId('ai-consent')).toBeHidden();
  await expect(live(page)).toContainText('the AI service does not answer');
  await close(context);
});

test('a cancelled status re-fetch: Ask asks the status again before the dialog shows the version', async ({
  browser,
}) => {
  const { context, page, svc } = await setup(browser, {
    explain: { status: 428, body: { error: 'consent_required' } },
    delayMs: 50,
    statusHangOn: 2,
  });
  await seedSessionConsent(page);
  await openPanelByKeyboard(page);
  svc.opts.status = STATUS({ consentVersion: '2026-12-01' });
  await tabTo(page, 'ai-ask');
  await page.keyboard.press('Enter');
  // The re-fetch (2nd status call) hangs; Cancel it by keyboard.
  await expect.poll(() => svc.calls.filter((c) => c.path === '/status').length).toBe(2);
  await tabTo(page, 'ai-cancel');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('ai-cancel')).toHaveCount(0);
  await expect(page.getByTestId('ai-ask')).toBeFocused();
  expect(svc.posts('/explain')).toHaveLength(1);
  // Ask again: the status is fetched again first, and the dialog shows the fresh version.
  await page.keyboard.press('Enter');
  await expect(page.locator('#ai-consent-h')).toBeFocused();
  await expect(page.getByTestId('ai-consent-version')).toContainText('2026-12-01');
  expect(svc.calls.filter((c) => c.path === '/status')).toHaveLength(3);
  await close(context);
});

test('without an account the consent is not kept beyond the browser session; with one it is', async ({
  browser,
}) => {
  const { context, page } = await setup(browser, { delayMs: 50 });
  await page.getByTestId('assist-open').click();
  await page.getByTestId('ai-ask').click();
  await page.getByTestId('ai-consent-agree').click();
  await expect(page.getByTestId('ai-result')).toHaveAttribute('data-state', 'success');
  expect(await consentKeys(page)).toEqual([`session:${SESSION_KEY}`]);
  // Another tab = another browser session for sessionStorage: asked again.
  const other = await openInNewTab(context);
  expect(await consentKeys(other)).toEqual([]);
  await other.getByTestId('assist-open').click();
  await other.getByTestId('ai-ask').click();
  await expect(other.getByTestId('ai-consent')).toBeVisible();
  await close(context);

  // With an opaque account reference: remembered in localStorage under acct:<ref>.
  const b = await setup(browser, { status: STATUS({ account: 'acc_7f3a' }), delayMs: 50 });
  await b.page.getByTestId('assist-open').click();
  await b.page.getByTestId('ai-ask').click();
  await b.page.getByTestId('ai-consent-agree').click();
  await expect(b.page.getByTestId('ai-result')).toHaveAttribute('data-state', 'success');
  expect(await consentKeys(b.page)).toEqual([
    'local:tbi-lab.assist.consent/acct:acc_7f3a/2026-11-22',
  ]);
  const tab = await openInNewTab(b.context);
  await tab.getByTestId('assist-open').click();
  await tab.getByTestId('ai-ask').click();
  await expect(tab.getByTestId('ai-result')).toHaveAttribute('data-state', 'success');
  await expect(tab.getByTestId('ai-consent')).toBeHidden();
  await close(b.context);
});

test('flag off: no service or a disabled one = findings-only, one sentence why, nothing POSTed', async ({
  browser,
}) => {
  for (const [status, reason, text] of [
    ['none', 'unavailable', 'the AI service does not answer'],
    [
      STATUS({ state: 'disabled', reasons: ['no_provider'], mode: undefined }),
      'disabled',
      'turned off',
    ],
    [STATUS({ pilot: false }), 'notAllowed', 'not available for your account yet'],
  ] as const) {
    const { context, page, svc } = await setup(browser, { status });
    await page.getByTestId('assist-open').click();
    const na = page.getByTestId('ai-not-available');
    await expect(na).toHaveAttribute('data-reason', reason);
    await expect(na).toContainText(text);
    await expect(live(page)).toContainText(text);
    await expect(page.getByTestId('ai-ask')).toHaveCount(0);
    // The deterministic debugger works as before (template explanation, labelled).
    await page.getByTestId('assist-analyze').click();
    await expect(page.getByTestId('assist-panel')).toHaveAttribute('data-phase', 'done', {
      timeout: 15_000,
    });
    await expect(page.getByTestId('assist-mock-label')).toBeVisible();
    await expect(page.getByTestId('ai-result')).toHaveCount(0);
    expect(svc.posts()).toHaveLength(0);
    await close(context);
  }
});

test('a new consent version asks again', async ({ browser }) => {
  const { context, page } = await setup(browser, {
    status: STATUS({ consentVersion: '2026-12-01' }),
  });
  await seedSessionConsent(page);
  await page.getByTestId('assist-open').click();
  await page.getByTestId('ai-ask').click();
  await expect(page.getByTestId('ai-consent')).toBeVisible();
  await expect(page.getByTestId('ai-consent-version')).toContainText('2026-12-01');
  await close(context);
});

test('HE: RTL panel and dialog, Hebrew text, LTR technical tokens, keyboard Agree', async ({
  browser,
}) => {
  const { context, page, svc } = await setup(browser, {});
  await page.getByTestId('language-select').selectOption('he');
  await openPanelByKeyboard(page);
  await expect(page.getByTestId('assist-panel')).toHaveAttribute('dir', 'rtl');
  await tabTo(page, 'ai-ask');
  await expect(page.getByTestId('ai-ask')).toHaveText('הסבר המעגל הזה');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'לשלוח את המעגל הזה ל-AI?' })).toBeVisible();
  await expect(page.locator('#ai-consent-h')).toBeFocused();
  expect(await page.getByTestId('ai-consent').evaluate((d) => getComputedStyle(d).direction)).toBe(
    'rtl',
  );
  await expect(page.getByTestId('ai-consent-version')).toContainText(`${LRI}2026-11-22`);
  await expect(page.getByTestId('ai-consent-never')).toContainText('שם הפרויקט');
  await tabTo(page, 'ai-preview');
  await page.keyboard.press('Enter');
  expect(await page.getByTestId('ai-payload').evaluate((e) => getComputedStyle(e).direction)).toBe(
    'ltr',
  );
  await tabTo(page, 'ai-consent-agree');
  await expect(page.getByTestId('ai-consent-agree')).toHaveText('הסכמה ושליחה');
  await page.keyboard.press('Enter');
  await expect(live(page)).toHaveText(/^התשובה מוכנה\. ממצאים שהוסברו: \d+\.$/);
  await expect(page.getByTestId('ai-label')).toHaveText(
    'נוצר על ידי AI, עלול לטעות. בדקו אותו מול ממצאי הסימולטור שלמעלה.',
  );
  await expect(page.getByTestId('assist-findings-note')).toContainText(
    'הם מגיעים מהסימולציה, לא מ-AI.',
  );
  expect((svc.posts('/explain')[0]!.body as { locale: string }).locale).toBe('he');
  // Cite links stay LTR technical tokens.
  expect(
    await page
      .getByTestId('assist-cite')
      .first()
      .evaluate((e) => getComputedStyle(e).direction),
  ).toBe('ltr');
  await close(context);
});

test('320 CSS px: panel and consent dialog reflow without horizontal scrolling', async ({
  browser,
}) => {
  const { context, page } = await setup(browser, {}, { width: 320, height: 640 });
  await page.getByTestId('assist-open').click();
  await page.getByTestId('ai-ask').click();
  const dialog = page.getByTestId('ai-consent');
  await expect(dialog).toBeVisible();
  await page.getByTestId('ai-preview').click();
  await expect(page.getByTestId('ai-payload')).toBeVisible();
  for (const id of ['assist-panel', 'ai-consent']) {
    const box = (await page.getByTestId(id).boundingBox())!;
    expect(box.x, id).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, id).toBeLessThanOrEqual(321);
  }
  expect(await dialog.evaluate((d) => d.scrollWidth <= d.clientWidth + 1)).toBe(true);
  // Targets >= 24 px for the dialog's buttons.
  for (const id of ['ai-preview', 'ai-consent-cancel', 'ai-consent-agree']) {
    const b = (await page.getByTestId(id).boundingBox())!;
    expect(b.height, id).toBeGreaterThanOrEqual(24);
    expect(b.width, id).toBeGreaterThanOrEqual(24);
  }
  await close(context);
});

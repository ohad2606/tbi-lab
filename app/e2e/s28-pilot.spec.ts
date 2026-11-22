/**
 * Sprint 28: the owner-only AI model pilot in the Circuit Debugger (DEV build on :4175).
 *
 * The browser talks only to the TBI Lab AI provider service (/assist/v1/*); here that service is
 * stubbed with page.route: the server itself is tested in runtime/assist/tests and on staging.
 * TBI-017 slice 1 UI (AI explanation in the panel; the status is asked once on opening):
 * - no service: "not available", no Ask button, nothing else happens;
 * - disabled: the missing owner approvals are listed (EN, HE), there is no way to send anything;
 * - active, not a pilot user: "not available for your account", no controls;
 * - active pilot user: nothing is sent until the user asks AND agrees in the consent dialog (which
 *   can preview EXACTLY what would leave TBI Lab); then exactly one request carrying the consent
 *   of the current version; the reply is shown as findings + labelled explanation; the project is
 *   unchanged (no write action exists). Consent is remembered for the session: withdrawing it
 *   brings the dialog back. The fuller keyboard/announcement coverage is a11y-ai-assistant.
 */
import { expect, test, type Page, type Route } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { EXPLAIN_CONTRACT, diagnose, renderPrompt, type EngineeringContext } from '@tbi-lab/assist';
import { createPackage, serializePackage, type ProjectDocument } from '@tbi-lab/domain';
import { ledLoop } from '../../packages/assist/eval/bench.js';
import { goToProjects, storedProjects, waitSaved } from './helpers.js';

const DEV = process.env.TBI_E2E_DEV_URL ?? 'http://127.0.0.1:4175';
const OUT = 'test-results/s28-pilot';
mkdirSync(OUT, { recursive: true });

async function openDev(page: Page, doc: ProjectDocument) {
  const text = serializePackage(
    createPackage(doc, { appVersion: '0.1.0', exportedAt: '2026-11-02T00:00:00.000Z' }),
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

async function analyze(page: Page) {
  await page.getByTestId('assist-open').click();
  await expect(page.getByTestId('assist-panel')).toBeVisible();
  await page.getByTestId('assist-analyze').click();
  await expect(page.getByTestId('assist-panel')).toHaveAttribute('data-phase', 'done', {
    timeout: 15_000,
  });
}

const DATA = {
  sent: [
    'instructions',
    'locale',
    'findings',
    'circuit',
    'checks_and_results',
    'build_status',
    'code_excerpts',
    'capabilities_and_assumptions',
  ],
  neverSent: [
    'identity',
    'project_name',
    'net_names',
    'comments_and_strings',
    'serial_output',
    'screenshots',
    'whole_source_files',
  ],
  auditRetentionDays: 30,
};
const status = (over: Record<string, unknown>) => ({
  protocol: 'tbi-lab.assist-service/1',
  pilot: true,
  consentVersion: '2026-11-02',
  limits: { perMinute: 3, perDay: 30, timeoutMs: 20000, maxOutputTokens: 1200 },
  data: DATA,
  ...over,
});
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** The service stub: records every request; explain answers from the real deterministic code. */
function stub(page: Page, st: Record<string, unknown>) {
  const calls: { path: string; body: unknown }[] = [];
  void page.route('**/assist/v1/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const body = req.postData() ? (JSON.parse(req.postData()!) as Record<string, unknown>) : null;
    calls.push({ path, body });
    if (path.endsWith('/status')) return json(route, status(st));
    const context = body!.context as EngineeringContext;
    const findings = diagnose(context);
    if (path.endsWith('/preview')) {
      const p = renderPrompt({
        contract: EXPLAIN_CONTRACT,
        locale: String(body!.locale),
        findings,
        context,
      });
      return json(route, {
        payload: p,
        bytes: Buffer.byteLength(p.system + p.user),
        estimatedInputTokens: Math.ceil((p.system + p.user).length / 4),
      });
    }
    if ((body!.consent as { accepted?: boolean } | undefined)?.accepted !== true)
      return json(route, { error: 'consent_required' }, 428);
    return json(route, {
      findings,
      response: {
        contract: EXPLAIN_CONTRACT,
        explanations: findings.map((f) => ({
          finding: f.key,
          text: 'Server template explanation; see the cited evidence.',
          cites: f.evidence.slice(0, 2),
        })),
      },
      unexplained: [],
      accounting: {
        provider: 'mock',
        model: 'template-mock-1',
        live: false,
        attempts: 1,
        inputTokens: 1400,
        outputTokens: 120,
        estimatedTokens: true,
        costUsd: 0,
        latencyMs: 12,
      },
    });
  });
  return calls;
}

const notFound = (page: Page) =>
  page.route('**/assist/v1/**', (route) => json(route, { error: 'not_found' }, 404));

test('no AI provider service: the pilot is unavailable and nothing is sent', async ({ page }) => {
  await notFound(page);
  await openDev(page, ledLoop(5, 0.1, null).doc);
  await analyze(page);
  await expect(page.getByTestId('ai-not-available')).toHaveAttribute('data-reason', 'unavailable');
  await expect(page.getByTestId('ai-ask')).toHaveCount(0);
  await expect(page.getByTestId('ai-consent')).toBeHidden();
});

test('disabled: the missing owner approvals are named (EN, HE); there is nothing to send', async ({
  page,
}) => {
  const calls = stub(page, {
    state: 'disabled',
    reasons: [
      'approval_missing:providerAndModel',
      'approval_missing:dataTerms',
      'approval_missing:spendCap',
      'approval_missing:securityReview',
      'approval_missing:ownerActivation',
      'no_pricing',
      'no_credential',
    ],
  });
  await openDev(page, ledLoop(5, 0.1, null).doc);
  await analyze(page);
  const na = page.getByTestId('ai-not-available');
  await expect(na).toHaveAttribute('data-reason', 'disabled');
  await expect(page.getByTestId('ai-reasons').locator('li')).toHaveCount(7);
  await expect(page.getByTestId('ai-reasons')).toContainText('hard monthly spending cap');
  await expect(page.getByTestId('ai-ask')).toHaveCount(0);
  await na.screenshot({ path: `${OUT}/disabled-en.png` });
  await page.getByTestId('language-select').selectOption('he');
  await expect(page.getByTestId('ai-reasons')).toContainText('תקרת הוצאה חודשית קשיחה');
  await na.screenshot({ path: `${OUT}/disabled-he.png` });
  expect(calls.every((c) => c.path.endsWith('/status'))).toBe(true);
});

test('active, but not a pilot user: no controls', async ({ page }) => {
  const calls = stub(page, {
    state: 'active',
    mode: 'mock',
    provider: 'mock',
    model: 'template-mock-1',
    pilot: false,
  });
  await openDev(page, ledLoop(5, 0.1, null).doc);
  await analyze(page);
  await expect(page.getByTestId('ai-not-available')).toHaveAttribute('data-reason', 'notAllowed');
  await expect(page.getByTestId('ai-ask')).toHaveCount(0);
  expect(calls.every((c) => c.path.endsWith('/status'))).toBe(true);
});

test('pilot user: exact preview, explicit consent, then one request; project unchanged (EN, HE)', async ({
  page,
}) => {
  const calls = stub(page, {
    state: 'active',
    mode: 'mock',
    provider: 'mock',
    model: 'template-mock-1',
  });
  await openDev(page, { ...ledLoop(5, 0.1, null).doc, name: 'Private project name' });
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-status')).toHaveAttribute('data-status', 'running');
  const before = JSON.stringify(await storedProjects(page));
  await analyze(page);
  const sentCalls = () => calls.filter((c) => !c.path.endsWith('/status'));
  // Opening and analysing sent nothing to explain or preview.
  expect(sentCalls()).toEqual([]);
  await page.getByTestId('ai-ask').click();
  const dialog = page.getByTestId('ai-consent');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('ai-consent-model')).toContainText('no AI model is involved');
  // Asking opens the dialog only: nothing is sent until the user agrees.
  expect(sentCalls()).toEqual([]);
  await page.getByTestId('ai-preview').click();
  const payload = page.getByTestId('ai-payload');
  await expect(page.getByTestId('ai-preview-status')).toContainText('Nothing has been sent');
  await expect(payload).toHaveAttribute('dir', 'ltr');
  await expect(payload).toContainText('current.led_overcurrent');
  await expect(payload).not.toContainText('Private project name');
  expect(calls.some((c) => c.path.endsWith('/explain'))).toBe(false);
  await dialog.screenshot({ path: `${OUT}/preview-en.png` });
  // Declining sends nothing and closes the dialog.
  await page.getByTestId('ai-consent-cancel').click();
  await expect(dialog).toBeHidden();
  expect(calls.some((c) => c.path.endsWith('/explain'))).toBe(false);
  // Asking again and agreeing: exactly one explain request, with the consent.
  await page.getByTestId('ai-ask').click();
  await expect(dialog).toBeVisible();
  await page.getByTestId('ai-consent-agree').click();
  const reply = page.getByTestId('ai-answer');
  await expect(reply).toHaveAttribute('data-same-findings', 'true');
  await expect(reply.getByTestId('assist-explanation').first()).toContainText(
    'Server template explanation',
  );
  await expect(reply.getByTestId('assist-accounting')).toContainText('template-mock-1');
  const explain = calls.filter((c) => c.path.endsWith('/explain'));
  expect(explain).toHaveLength(1);
  expect(explain[0]!.body).toMatchObject({
    consent: { version: '2026-11-02', accepted: true },
    locale: 'en',
  });
  expect(JSON.stringify(explain[0]!.body)).not.toContain('Private project name');
  expect(JSON.stringify(await storedProjects(page))).toBe(before);

  // Hebrew: a new analysis clears the answer; nothing is resent on the locale change.
  await page.getByTestId('language-select').selectOption('he');
  await page.getByTestId('assist-analyze').click();
  await expect(page.getByTestId('assist-panel')).toHaveAttribute('data-phase', 'done', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('ai-answer')).toHaveCount(0);
  expect(calls.filter((c) => c.path.endsWith('/explain'))).toHaveLength(1);
  // The consent is remembered for the session; withdrawing it brings the dialog back.
  await page.getByTestId('ai-withdraw').click();
  await page.getByTestId('ai-ask').click();
  await expect(dialog).toBeVisible();
  await page.getByTestId('ai-preview').click();
  await expect(page.getByTestId('ai-preview-status')).toContainText('שום דבר לא נשלח');
  await dialog.screenshot({ path: `${OUT}/preview-he.png` });
  await page.getByTestId('ai-consent-cancel').click();
  await expect(dialog).toBeHidden();
  expect(calls.filter((c) => c.path.endsWith('/explain'))).toHaveLength(1);
  expect(JSON.stringify(await storedProjects(page))).toBe(before);
});

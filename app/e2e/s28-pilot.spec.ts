/**
 * Sprint 28: the owner-only AI model pilot in the Circuit Debugger (DEV build on :4175).
 *
 * The browser talks only to the TBI Lab AI provider service (/assist/v1/*); here that service is
 * stubbed with page.route: the server itself is tested in runtime/assist/tests and on staging.
 * - no service: the pilot says it is unavailable, nothing else happens;
 * - disabled: the missing owner approvals are listed (EN, HE), there is no way to send anything;
 * - active, not a pilot user: no controls;
 * - active pilot user: nothing is sent until the user previews EXACTLY what would leave TBI Lab and
 *   gives consent of the current version; the reply is shown as findings + labelled explanation;
 *   the project is unchanged (no write action exists).
 */
import { expect, test, type Page, type Route } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { EXPLAIN_CONTRACT, diagnose, renderPrompt, type EngineeringContext } from '@tbi-lab/assist';
import { createPackage, serializePackage, type ProjectDocument } from '@tbi-lab/domain';
import { ledLoop } from '../../packages/assist/eval/bench.js';
import { goToProjects, storedProjects, waitSaved } from './helpers.js';

const DEV = 'http://127.0.0.1:4175';
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

test('no AI provider service: the pilot is unavailable and nothing is sent', async ({ page }) => {
  await openDev(page, ledLoop(5, 0.1, null).doc);
  await analyze(page);
  await expect(page.getByTestId('assist-pilot-unavailable')).toBeVisible();
  await expect(page.getByTestId('assist-pilot-preview')).toHaveCount(0);
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
  const pilot = page.getByTestId('assist-pilot');
  await expect(pilot).toHaveAttribute('data-state', 'disabled');
  await expect(page.getByTestId('assist-pilot-reasons').locator('li')).toHaveCount(7);
  await expect(page.getByTestId('assist-pilot-reasons')).toContainText('hard monthly spending cap');
  await expect(page.getByTestId('assist-pilot-preview')).toHaveCount(0);
  await pilot.screenshot({ path: `${OUT}/disabled-en.png` });
  await page.getByTestId('language-select').selectOption('he');
  await expect(page.getByTestId('assist-pilot-reasons')).toContainText('תקרת הוצאה חודשית קשיחה');
  await pilot.screenshot({ path: `${OUT}/disabled-he.png` });
  expect(calls.every((c) => c.path.endsWith('/status'))).toBe(true);
});

test('active, but not a pilot user: no controls', async ({ page }) => {
  stub(page, {
    state: 'active',
    mode: 'mock',
    provider: 'mock',
    model: 'template-mock-1',
    pilot: false,
  });
  await openDev(page, ledLoop(5, 0.1, null).doc);
  await analyze(page);
  await expect(page.getByTestId('assist-pilot-not-pilot')).toBeVisible();
  await expect(page.getByTestId('assist-pilot-preview')).toHaveCount(0);
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
  await expect(page.getByTestId('assist-pilot-model')).toContainText('no AI model is involved');
  // Opening and analysing sent nothing to explain or preview.
  expect(calls.map((c) => c.path).filter((p) => !p.endsWith('/status'))).toEqual([]);
  await page.getByTestId('assist-pilot-preview').click();
  const payload = page.getByTestId('assist-pilot-payload');
  await expect(payload).toContainText('Nothing has been sent');
  await expect(payload.locator('pre')).toHaveAttribute('dir', 'ltr');
  await expect(payload.locator('pre')).toContainText('current.led_overcurrent');
  await expect(payload.locator('pre')).not.toContainText('Private project name');
  // Send stays disabled without consent.
  await expect(page.getByTestId('assist-pilot-send')).toBeDisabled();
  expect(calls.some((c) => c.path.endsWith('/explain'))).toBe(false);
  await page.getByTestId('assist-pilot-consent').check();
  await page.getByTestId('assist-pilot').screenshot({ path: `${OUT}/preview-en.png` });
  await page.getByTestId('assist-pilot-send').click();
  const reply = page.getByTestId('assist-pilot-reply');
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

  // Hebrew: a new analysis resets preview and consent; nothing is resent on the locale change.
  await page.getByTestId('language-select').selectOption('he');
  await page.getByTestId('assist-analyze').click();
  await expect(page.getByTestId('assist-panel')).toHaveAttribute('data-phase', 'done', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('assist-pilot-payload')).toHaveCount(0);
  expect(calls.filter((c) => c.path.endsWith('/explain'))).toHaveLength(1);
  await page.getByTestId('assist-pilot-preview').click();
  await expect(page.getByTestId('assist-pilot-send')).toBeDisabled();
  await expect(page.getByTestId('assist-pilot-payload')).toContainText('שום דבר לא נשלח');
  await page.getByTestId('assist-pilot').screenshot({ path: `${OUT}/preview-he.png` });
  expect(JSON.stringify(await storedProjects(page))).toBe(before);
});

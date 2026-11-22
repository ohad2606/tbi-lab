/**
 * TBI-017 slice 2: TBI-018 limit refusals and the credits line in the AI panel (DEV-Lab build on
 * :4175), against a MOCK AI service (Playwright route interception of /assist/v1/* in each
 * test's own browser context; no real provider). The refusal bodies are exactly the shape of
 * runtime/assist/service.ts `limitResponse`: {error, limit:{code, messageKey, params}, message?}.
 *
 * - Limit reached = role=alert with the service's text in the UI language (fallback: client
 *   keys), re-mounted per occurrence; the simulator findings stay; no "Try again" where the same
 *   request cannot succeed; focus stays on Ask (never stolen by the alert, never lost).
 * - rate / retryAfterMs: Ask is aria-disabled until the wait is over; no request is made in the
 *   meantime and none after it by itself (no auto-retry).
 * - Credits line: shown under Ask only when the status carries `credits`; numbers as given,
 *   LTR-isolated; announced in the polite region when they change (not on open).
 * - EN and HE (RTL), 320 CSS px.
 */
import { expect, test, type Browser, type Page, type Route } from '@playwright/test';
import { createPackage, serializePackage, type ProjectDocument } from '@tbi-lab/domain';
import { EXPLAIN_CONTRACT, diagnose, type EngineeringContext } from '@tbi-lab/assist';
import { ledLoop } from '../../packages/assist/eval/bench.js';
import { goToProjects, waitSaved } from './helpers.js';

const DEV = process.env.TBI_E2E_DEV_URL ?? 'http://127.0.0.1:4175';
const LRI = '⁦';
const PDI = '⁩';
/** Numbers as the panel shows them inside a sentence: isolated LTR. */
const iso = (s: string) => s.replace(/\d+(?:[.:/]\d+)*/g, (m) => `${LRI}${m}${PDI}`);

type Reply = 'ok' | { status: number; body: Record<string, unknown> };

const STATUS = (over: Record<string, unknown> = {}) => ({
  protocol: 'tbi-lab.assist-service/1',
  state: 'active',
  mode: 'live',
  provider: 'mockprov',
  model: 'mock-model-1',
  pilot: true,
  consentVersion: '2026-11-22',
  data: {
    sent: ['instructions', 'locale', 'findings', 'circuit'],
    neverSent: ['identity', 'project_name'],
    auditRetentionDays: 30,
  },
  ...over,
});

/** The service texts (runtime/plans/messages.ts), rendered as limitResponse sends them. */
const MSG: Record<string, { he: string; en: string }> = {
  credits_out: {
    he: 'נגמרו קרדיטי ה-AI שלך לחודש הזה. הם יתחדשו ב-01.12.2026. הסימולטור וכל ההסברים ממשיכים לעבוד. אפשר לרכוש חבילת קרדיטים או לשדרג מסלול.',
    en: 'You have used all your AI credits for this month. They renew on 01.12.2026. The simulator and all explanations keep working. You can buy a credit pack or upgrade your plan.',
  },
  credits_out_free: {
    he: 'נגמרו קרדיטי ה-AI החינמיים שלך לחודש הזה. הם יתחדשו ב-01.12.2026. הסימולטור וכל ההסברים ממשיכים לעבוד. רוצה עוד? אפשר לשדרג למסלול מתקדם.',
    en: 'You have used your free AI credits for this month. They renew on 01.12.2026. The simulator and all explanations keep working. Want more? You can upgrade to Advanced.',
  },
  daily: {
    he: 'הגעת למגבלה היומית של עזרת ה-AI. היא תתאפס מחר. הסימולטור ממשיך לעבוד כרגיל.',
    en: "You have reached today's AI assistant limit. It resets tomorrow. The simulator keeps working as usual.",
  },
  global_off: {
    he: 'עוזר ה-AI נח כרגע ויחזור בהקדם. הסימולטור וכל ההסברים ממשיכים לעבוד. הקרדיטים שלך לא נוצלו.',
    en: 'The AI assistant is resting for now and will be back soon. The simulator and all explanations keep working. Your credits were not used.',
  },
  deep_not_in_plan: {
    he: 'מצב העומק זמין במסלול מתקדם ומעלה. אפשר לשאול שאלה רגילה, או לשדרג מסלול.',
    en: 'Deep mode is available on the Advanced plan and above. You can ask a standard question, or upgrade your plan.',
  },
  rate: {
    he: 'יותר מדי בקשות בזמן קצר. אפשר לנסות שוב בעוד 2 שניות.',
    en: 'Too many requests in a short time. Please try again in 2 seconds.',
  },
  system_unavailable: {
    he: 'השירות זמנית לא זמין ולא חויבת. נסו שוב בעוד רגע.',
    en: 'The service is temporarily unavailable and you were not charged. Please try again shortly.',
  },
};
const HTTP: Record<string, number> = {
  credits_out: 429,
  credits_out_free: 429,
  daily: 429,
  rate: 429,
  global_off: 503,
  too_long: 413,
  deep_not_in_plan: 403,
  system_unavailable: 503,
};
const refusal = (
  code: string,
  params: Record<string, string | number> = {},
  withMessage = true,
): Reply => ({
  status: HTTP[code]!,
  body: {
    error: code,
    limit: {
      code,
      messageKey: code === 'system_unavailable' ? 'limit.system.unavailable' : `limit.ai.${code}`,
      params,
    },
    ...(withMessage && MSG[code] ? { message: MSG[code] } : {}),
  },
});

class MockService {
  readonly calls: { method: string; path: string }[] = [];
  /** Status answers in order (the last one repeats). */
  statuses: Record<string, unknown>[];
  /** Explain answers in order (the last one repeats). */
  replies: Reply[];
  constructor(o: { statuses?: Record<string, unknown>[]; replies?: Reply[] }) {
    this.statuses = o.statuses ?? [STATUS()];
    this.replies = o.replies ?? ['ok'];
  }
  count(method: string, path: string) {
    return this.calls.filter((c) => c.method === method && c.path === path).length;
  }
  async handle(route: Route) {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace('/assist/v1', '');
    this.calls.push({ method: req.method(), path });
    const json = (status: number, b: unknown) =>
      route
        .fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) })
        .catch(() => undefined);
    const nth = <T>(list: T[], n: number) => list[Math.min(n, list.length - 1)]!;
    if (path === '/status') return json(200, nth(this.statuses, this.count('GET', '/status') - 1));
    if (path === '/explain') {
      const reply = nth(this.replies, this.count('POST', '/explain') - 1);
      await new Promise((r) => setTimeout(r, 80));
      if (reply !== 'ok') return json(reply.status, reply.body);
      const ctx = (JSON.parse(req.postData()!) as { context: EngineeringContext }).context;
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
          latencyMs: 80,
        },
      });
    }
    return json(404, { error: 'not_found' });
  }
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

/** Own browser context, mock service, project open, consent of this session already given. */
async function setup(
  browser: Browser,
  o: ConstructorParameters<typeof MockService>[0],
  opts: { lang?: string; viewport?: { width: number; height: number } } = {},
) {
  const context = await browser.newContext({
    viewport: opts.viewport ?? { width: 1400, height: 860 },
  });
  const svc = new MockService(o);
  await context.route('**/assist/v1/**', (r) => svc.handle(r));
  const page = await context.newPage();
  await openDev(page, { ...ledLoop(5, 0.1, null).doc, name: 'AI limits spec' });
  if (opts.lang) await page.getByTestId('language-select').selectOption(opts.lang);
  await page.evaluate(() =>
    sessionStorage.setItem(
      'tbi-lab.assist.consent/session/2026-11-22',
      JSON.stringify({ accepted: true, who: 'c35f4cf784e067b5', at: '2026-11-22T00:00:00.000Z' }),
    ),
  );
  await page.getByTestId('assist-open').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#assist-title')).toBeFocused();
  await expect(page.getByTestId('ai-ask')).toBeVisible();
  return { context, page, svc };
}

/** Ask by keyboard (focus on Ask, Enter). */
async function ask(page: Page) {
  await page.getByTestId('ai-ask').focus();
  await page.keyboard.press('Enter');
}

const live = (page: Page) => page.getByTestId('assist-live');

test.describe.configure({ mode: 'serial' });

test('EN: each limit shows the service text as an alert; findings stay; no retry; focus stays on Ask', async ({
  browser,
}) => {
  const codes = ['credits_out', 'credits_out_free', 'daily', 'global_off', 'deep_not_in_plan'];
  const { context, page, svc } = await setup(browser, {});
  for (const [i, code] of codes.entries()) {
    // One reply in the list: it is the answer to every following request.
    svc.replies = [refusal(code, code.startsWith('credits_out') ? { date: '01.12.2026' } : {})];
    await ask(page);
    const alert = page.getByRole('alert');
    await expect(page.getByTestId('ai-limit')).toHaveAttribute('data-limit', code);
    await expect(page.getByTestId('ai-limit')).toHaveAttribute('data-source', 'service');
    await expect(alert).toHaveCount(1);
    await expect(alert).toContainText(iso(MSG[code]!.en));
    await expect(alert).toContainText('The simulator findings above are unaffected.');
    await expect(page.getByTestId('ai-error')).toHaveCount(0);
    // Not a "Try again" case: the button keeps its own name and stays usable.
    await expect(page.getByTestId('ai-ask')).toHaveText('Explain this circuit');
    await expect(page.getByTestId('ai-ask')).not.toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId('ai-ask')).toBeFocused();
    await expect(page.getByTestId('assist-findings')).toBeVisible();
    await expect(page.getByTestId('ai-label')).toBeVisible();
    expect(svc.count('POST', '/explain')).toBe(i + 1);
  }
  // No credits in the status: no credits line and no extra status request.
  await expect(page.getByTestId('ai-credits')).toHaveCount(0);
  expect(svc.count('GET', '/status')).toBe(1);
  // Tab moves on from Ask (the alert never traps or steals focus).
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('ai-ask')).not.toBeFocused();
  await context.close();
});

test('the same limit again is a new alert (announced again); fallback text without a service message', async ({
  browser,
}) => {
  const { context, page, svc } = await setup(browser, {
    replies: [refusal('daily', {}, false)],
  });
  await ask(page);
  const limit = page.getByTestId('ai-limit');
  await expect(limit).toHaveAttribute('data-source', 'client');
  await expect(limit).toContainText(
    'You have reached today’s limit of AI explanations. It resets tomorrow.',
  );
  const first = await limit.elementHandle();
  await ask(page);
  await expect.poll(() => svc.count('POST', '/explain')).toBe(2);
  await expect(page.getByRole('alert')).toHaveCount(1);
  await expect.poll(async () => (await limit.elementHandle()) !== first).toBe(true);
  // credits_out without a usable date: the sentence without a date (never "{date}").
  svc.replies = [refusal('credits_out', {}, false)];
  await ask(page);
  await expect(limit).toHaveAttribute('data-limit', 'credits_out');
  await expect(limit).toContainText('You have used all your AI credits for this period.');
  await expect(limit).not.toContainText('{');
  // too_long with its client text.
  svc.replies = [refusal('too_long', {}, false)];
  await ask(page);
  await expect(limit).toContainText('This project is too large for one AI explanation.');
  await context.close();
});

test('rate and retryAfterMs: Ask waits (aria-disabled, no request), then offers Try again; no auto-retry', async ({
  browser,
}) => {
  const { context, page, svc } = await setup(browser, {
    replies: [refusal('rate', { n: 2 })],
  });
  await ask(page);
  const limit = page.getByTestId('ai-limit');
  await expect(limit).toHaveAttribute('data-limit', 'rate');
  await expect(limit).toContainText(iso(MSG.rate!.en));
  await expect(page.getByTestId('ai-limit-wait')).toHaveCount(0); // the sentence says when
  const askBtn = page.getByTestId('ai-ask');
  await expect(askBtn).toHaveAttribute('aria-disabled', 'true');
  await expect(askBtn).toBeFocused();
  await expect(askBtn).toHaveAttribute('aria-describedby', 'ai-limit-text');
  await expect(page.locator('#ai-limit-text')).toContainText(iso(MSG.rate!.en));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  expect(svc.count('POST', '/explain')).toBe(1);
  await expect(askBtn).not.toHaveAttribute('aria-disabled', 'true', { timeout: 4000 });
  await expect(askBtn).not.toHaveAttribute('aria-describedby');
  await expect(askBtn).toHaveText('Try again');
  await expect(askBtn).toBeFocused();
  // Nothing was retried by the client on its own.
  await page.waitForTimeout(500);
  expect(svc.count('POST', '/explain')).toBe(1);

  // system_unavailable with a service wait: the separate wait line, then Try again.
  const unavailable = refusal('system_unavailable') as Exclude<Reply, 'ok'>;
  svc.replies = [{ ...unavailable, body: { ...unavailable.body, retryAfterMs: 1500 } }];
  await ask(page);
  await expect(limit).toHaveAttribute('data-limit', 'system_unavailable');
  await expect(limit).toContainText(MSG.system_unavailable!.en);
  await expect(page.getByTestId('ai-limit-wait')).toHaveText(
    `You can try again in ${LRI}2${PDI} s.`,
  );
  await expect(askBtn).toHaveAttribute('aria-disabled', 'true');
  await expect(askBtn).not.toHaveAttribute('aria-disabled', 'true', { timeout: 4000 });
  await expect(askBtn).toHaveText('Try again');
  expect(svc.count('POST', '/explain')).toBe(2);
  await context.close();
});

test('credits line: shown as given, updated after an answer and after a refusal, announced on change only', async ({
  browser,
}) => {
  const credits = (remaining: number) => ({ plan: 'free', remaining, total: 30 });
  const { context, page, svc } = await setup(browser, {
    statuses: [
      STATUS({ credits: credits(12) }),
      STATUS({ credits: credits(11) }),
      STATUS({ credits: credits(0) }),
      STATUS({}),
    ],
    replies: ['ok', refusal('credits_out_free', { date: '01.12.2026' })],
  });
  const line = page.getByTestId('ai-credits');
  await expect(line).toHaveText(iso('AI credits left: 12 of 30.') + ' Plan: Free.');
  // Not announced on open (visible text; the region announces changes).
  await page.waitForTimeout(300);
  await expect(live(page)).not.toContainText('credits');
  // Under the Ask button, before the findings and the AI section.
  const askBox = (await page.getByTestId('ai-ask').boundingBox())!;
  expect((await line.boundingBox())!.y).toBeGreaterThan(askBox.y);

  await ask(page);
  await expect(page.getByTestId('ai-result')).toHaveAttribute('data-state', 'success');
  await expect(line).toHaveText(iso('AI credits left: 11 of 30.') + ' Plan: Free.');
  await expect(live(page)).toContainText(iso('AI credits left: 11 of 30.'));
  await expect(live(page)).toContainText('Answer ready.');
  expect(svc.count('GET', '/status')).toBe(2);
  await expect(page.getByTestId('ai-ask')).toBeFocused();

  await ask(page);
  await expect(page.getByTestId('ai-limit')).toHaveAttribute('data-limit', 'credits_out_free');
  await expect(line).toHaveText(iso('AI credits left: 0 of 30.') + ' Plan: Free.');
  await expect(live(page)).toContainText(iso('AI credits left: 0 of 30.'));
  expect(svc.count('GET', '/status')).toBe(3);

  // A status without credits: the line goes (never an old number), and no more re-fetches.
  svc.replies = ['ok'];
  await ask(page);
  await expect(page.getByTestId('ai-result')).toHaveAttribute('data-state', 'success');
  await expect(line).toHaveCount(0);
  expect(svc.count('GET', '/status')).toBe(4);
  await ask(page);
  await expect.poll(() => svc.count('POST', '/explain')).toBe(4);
  await page.waitForTimeout(300);
  expect(svc.count('GET', '/status')).toBe(4);
  await context.close();
});

test('language switch with credits shown: the line follows the language, nothing is re-announced, the next change is announced in the new language', async ({
  browser,
}) => {
  const credits = (remaining: number) => ({ plan: 'free', remaining, total: 30 });
  const { context, page } = await setup(browser, {
    statuses: [STATUS({ credits: credits(12) }), STATUS({ credits: credits(11) })],
    replies: ['ok'],
  });
  const line = page.getByTestId('ai-credits');
  await expect(line).toHaveText(iso('AI credits left: 12 of 30.') + ' Plan: Free.');
  await page.getByTestId('language-select').selectOption('he');
  await expect(line).toHaveText(
    `קרדיטי AI שנותרו: ${LRI}12${PDI} מתוך ${LRI}30${PDI}. מסלול: חינמי.`,
  );
  await page.waitForTimeout(400);
  await expect(live(page)).toHaveText('');
  await ask(page);
  await expect(page.getByTestId('ai-result')).toHaveAttribute('data-state', 'success');
  await expect(live(page)).toContainText(`קרדיטי AI שנותרו: ${LRI}11${PDI} מתוך ${LRI}30${PDI}`);
  await expect(live(page)).not.toContainText('AI credits left');
  await context.close();
});

test('a limit refusal is announced once: one alert, and the polite region does not repeat it', async ({
  browser,
}) => {
  const { context, page } = await setup(browser, {
    replies: [refusal('daily', { n: 1 })],
  });
  await ask(page);
  await expect(page.getByTestId('ai-limit')).toHaveAttribute('data-limit', 'daily');
  await page.waitForTimeout(400);
  await expect(page.getByRole('alert')).toHaveCount(1);
  await expect(live(page)).not.toContainText(iso(MSG.daily!.en));
  await expect(live(page)).not.toContainText('limit');
  await context.close();
});

test('HE: service text in Hebrew with LTR numbers, RTL alert, Hebrew fallback, Hebrew credits line', async ({
  browser,
}) => {
  const { context, page, svc } = await setup(
    browser,
    {
      statuses: [STATUS({ credits: { plan: 'advanced', remaining: 5, total: 400 } })],
      replies: [refusal('credits_out', { date: '01.12.2026' })],
    },
    { lang: 'he' },
  );
  await expect(page.getByTestId('assist-panel')).toHaveAttribute('dir', 'rtl');
  const line = page.getByTestId('ai-credits');
  await expect(line).toHaveText(
    `קרדיטי AI שנותרו: ${LRI}5${PDI} מתוך ${LRI}400${PDI}. מסלול: מתקדם.`,
  );
  await ask(page);
  const limit = page.getByTestId('ai-limit');
  await expect(limit).toHaveAttribute('role', 'alert');
  await expect(limit).toContainText(iso(MSG.credits_out!.he));
  await expect(limit).toContainText(`${LRI}01.12.2026${PDI}`);
  expect(await limit.evaluate((e) => getComputedStyle(e).direction)).toBe('rtl');
  await expect(page.getByTestId('ai-ask')).toHaveText('הסבר המעגל הזה');
  await expect(page.getByTestId('ai-ask')).toBeFocused();
  // Hebrew fallback (no service text).
  svc.replies = [refusal('daily', {}, false)];
  await ask(page);
  await expect(limit).toHaveAttribute('data-source', 'client');
  await expect(limit).toContainText('הגעתם למגבלה היומית של הסברי AI.');
  // rate in Hebrew: seconds isolated, Ask waits.
  svc.replies = [refusal('rate', { n: 2 })];
  await ask(page);
  await expect(limit).toContainText(iso(MSG.rate!.he));
  await expect(page.getByTestId('ai-ask')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('ai-ask')).toHaveText('ניסיון חוזר', { timeout: 4000 });
  await context.close();
});

test('320 CSS px: the limit alert and the credits line reflow without horizontal scrolling', async ({
  browser,
}) => {
  const { context, page } = await setup(
    browser,
    {
      statuses: [STATUS({ credits: { plan: 'pro', remaining: 1500, total: 1500 } })],
      replies: [refusal('credits_out', { date: '01.12.2026' })],
    },
    { viewport: { width: 320, height: 640 } },
  );
  await ask(page);
  await expect(page.getByTestId('ai-limit')).toBeVisible();
  for (const id of ['assist-panel', 'ai-limit', 'ai-credits']) {
    const box = (await page.getByTestId(id).boundingBox())!;
    expect(box.x, id).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, id).toBeLessThanOrEqual(321);
  }
  expect(
    await page.getByTestId('assist-panel').evaluate((p) => p.scrollWidth <= p.clientWidth + 1),
  ).toBe(true);
  const b = (await page.getByTestId('ai-ask').boundingBox())!;
  expect(b.height).toBeGreaterThanOrEqual(24);
  await context.close();
});

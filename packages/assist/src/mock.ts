/**
 * Sprint 27: the deterministic mock provider. NOT a language model: it fills localized templates
 * (owned by the app's message catalogs, injected as `render`) from each finding's family and its
 * evidence facts. Same input, same text. It goes through exactly the gateway and validation a real
 * provider would, so the contract, the UI and the evaluation bench are exercised end to end
 * without any external service, credential or cost. `live` is false: the UI says so.
 */
import type { Finding } from './diagnose.js';
import {
  EXPLAIN_CONTRACT,
  type AssistProvider,
  type ExplainRequest,
  type ExplainResponse,
  type ProviderReply,
} from './provider.js';

/**
 * Template text for `key` in `locale`, with `params` filled (the app's translate + formatting).
 * Numbers are passed as numbers with their SI unit so the renderer formats them for the locale.
 */
export type TemplateRenderer = (
  key: string,
  params: Record<string, string | { value: number; unit: string }>,
  locale: string,
) => string;

export interface MockOptions {
  render: TemplateRenderer;
  /** Artificial latency, ms (UI demonstration of the pending state); 0 by default. */
  delayMs?: number;
}

/** The template params a finding provides: ids, pins and the numbers its evidence states. */
export function templateParams(
  f: Finding,
): Record<string, string | { value: number; unit: string }> {
  const p: Record<string, string | { value: number; unit: string }> = {
    components: f.components.join(', '),
    pins: f.pins.map((g) => `GPIO${g}`).join(', '),
    code: f.code,
  };
  const unit = typeof f.facts.unit === 'string' ? f.facts.unit : '';
  if (typeof f.facts.value === 'number') p.value = { value: f.facts.value, unit };
  if (typeof f.facts.limit === 'number') p.limit = { value: f.facts.limit, unit };
  if (typeof f.facts.file === 'string') p.file = f.facts.file;
  if (typeof f.facts.line === 'number') p.line = String(f.facts.line);
  for (const k of ['feature', 'facility', 'capability', 'features'] as const)
    if (typeof f.facts[k] === 'string') p.feature = f.facts[k] as string;
  return p;
}

/** The template a finding is explained with: its id's own, else its family's. */
export function templateKey(f: Finding, has: (key: string) => boolean): string {
  const own = `assist.mock.${f.id}`;
  if (has(own)) return own;
  return `assist.mock.family.${f.family}${f.certainty === 'indeterminate' ? '.indeterminate' : ''}`;
}

export class MockProvider implements AssistProvider {
  readonly id = 'mock';
  readonly model = 'template-mock-1';
  readonly live = false;
  readonly pricing = { inputPerMTok: 0, outputPerMTok: 0 };

  constructor(private readonly opts: MockOptions & { has: (key: string) => boolean }) {}

  async complete(
    request: ExplainRequest,
    _prompt: unknown,
    signal: AbortSignal,
  ): Promise<ProviderReply> {
    if (this.opts.delayMs)
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.opts.delayMs);
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    return { body: mockExplain(request, this.opts.render, this.opts.has) };
  }
}

/** The mock's reply for a request (exported for the evaluation bench and tests). */
export function mockExplain(
  request: ExplainRequest,
  render: TemplateRenderer,
  has: (key: string) => boolean,
): ExplainResponse {
  const explanations = request.findings.map((f) => ({
    finding: f.key,
    text: render(templateKey(f, has), templateParams(f), request.locale),
    cites: f.evidence.slice(0, 12),
  }));
  const errors = request.findings.filter((f) => f.severity === 'error').length;
  const warnings = request.findings.filter((f) => f.severity === 'warning').length;
  const first = request.findings[0];
  return {
    contract: EXPLAIN_CONTRACT,
    explanations,
    ...(first
      ? {
          summary: {
            text: render(
              errors
                ? 'assist.mock.summary.errors'
                : warnings
                  ? 'assist.mock.summary.warnings'
                  : 'assist.mock.summary.clear',
              {},
              request.locale,
            ),
            cites: [...new Set(request.findings.flatMap((f) => f.evidence))].slice(0, 12),
          },
        }
      : {}),
  };
}

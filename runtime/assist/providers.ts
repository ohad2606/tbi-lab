/**
 * Sprint 28: provider adapters for the AI provider service. Every adapter implements the
 * provider-neutral `AssistProvider` of @tbi-lab/assist (the same contract the browser's mock uses),
 * so the gateway, the strict response validation and the evaluation harness are identical for all.
 *
 * - `mock`: the deterministic template provider (nothing leaves the host);
 * - `anthropic`: the first candidate external provider, through the official SDK. INACTIVE: built
 *   only when the configuration is fully approved (config.ts `activation`), and the service's
 *   systemd unit denies all IP traffic until the owner changes it at activation.
 *
 * The reply is constrained twice: the provider is asked for JSON matching EXPLAIN_RESPONSE_SCHEMA
 * (structured output), and the gateway's `validateResponse` then checks every claim against the
 * evidence (unknown ids, numbers, identifiers, links). The schema never replaces that check.
 */
import Anthropic from '@anthropic-ai/sdk';
import {
  EXPLAIN_CONTRACT,
  MockProvider,
  ProviderError,
  RESPONSE_LIMITS,
  type AssistProvider,
  type ExplainRequest,
  type Prompt,
  type ProviderReply,
} from '@tbi-lab/assist';
import type { AssistServiceConfig } from './config.js';

/** The reply's JSON schema (contract tbi-lab.assist.explain/1), for providers that accept one. */
export const EXPLAIN_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['contract', 'explanations'],
  properties: {
    contract: { type: 'string', enum: [EXPLAIN_CONTRACT] },
    explanations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['finding', 'text', 'cites'],
        properties: {
          finding: { type: 'string' },
          text: { type: 'string' },
          cites: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    summary: {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'cites'],
      properties: { text: { type: 'string' }, cites: { type: 'array', items: { type: 'string' } } },
    },
    declined: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['finding', 'reason'],
        properties: {
          finding: { type: 'string' },
          reason: { type: 'string', enum: ['insufficient_evidence', 'out_of_scope'] },
        },
      },
    },
  },
} as const;

/**
 * Server-side mock: one fixed, locale-neutral sentence per finding (no numbers, no identifiers),
 * so it passes the same strict validator a live reply must pass. Nothing leaves the host.
 */
export function serverMock(): AssistProvider {
  return new MockProvider({
    render: () => 'Template explanation from the deterministic mock; see the finding it cites.',
    has: () => false,
  });
}

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  pricing: { inputPerMTok: number; outputPerMTok: number };
  maxOutputTokens: number;
  /** Tests only: a local fake API. Production uses the SDK default. */
  baseURL?: string;
}

/**
 * The Anthropic Messages API adapter. One attempt per call: retries, timeouts, rates and cost
 * ceilings belong to the gateway and the service (SDK retries off, so nothing is resent unseen).
 */
export class AnthropicProvider implements AssistProvider {
  readonly id = 'anthropic';
  readonly live = true;
  readonly model: string;
  readonly pricing: { inputPerMTok: number; outputPerMTok: number };
  private readonly client: Anthropic;
  private readonly maxOutputTokens: number;

  constructor(o: AnthropicOptions) {
    this.model = o.model;
    this.pricing = o.pricing;
    this.maxOutputTokens = o.maxOutputTokens;
    this.client = new Anthropic({
      apiKey: o.apiKey,
      maxRetries: 0,
      ...(o.baseURL ? { baseURL: o.baseURL } : {}),
    });
  }

  async complete(
    _req: ExplainRequest,
    prompt: Prompt,
    signal: AbortSignal,
  ): Promise<ProviderReply> {
    let r: Anthropic.Message;
    try {
      r = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: this.maxOutputTokens,
          system: prompt.system,
          messages: [{ role: 'user', content: prompt.user }],
          output_config: {
            effort: 'low',
            format: { type: 'json_schema', schema: EXPLAIN_RESPONSE_SCHEMA },
          },
        },
        { signal },
      );
    } catch (e) {
      throw providerError(e);
    }
    const usage = { inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens };
    // A refusal or a cut-off reply is never parsed into an explanation.
    if (r.stop_reason === 'refusal')
      throw Object.assign(new ProviderError('refused', false), { usage });
    if (r.stop_reason !== 'end_turn')
      throw Object.assign(new ProviderError('internal', false), { usage });
    const text = r.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    // Bound before parsing: a reply larger than the contract allows is not read.
    const maxChars = (RESPONSE_LIMITS.maxTextChars + 200) * 64;
    if (text.length > maxChars) return { body: null, usage };
    try {
      return { body: JSON.parse(text) as unknown, usage };
    } catch {
      return { body: null, usage };
    }
  }
}

function providerError(e: unknown): ProviderError {
  if (e instanceof Anthropic.APIUserAbortError) throw e; // cancellation: the gateway's own
  if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError)
    return new ProviderError('overloaded', true);
  if (e instanceof Anthropic.APIConnectionError) return new ProviderError('network', true);
  if (e instanceof Anthropic.APIError) return new ProviderError('refused', false);
  return new ProviderError('internal', false);
}

/** The configured provider, or null when none may run (never a live one without approvals). */
export function createProvider(
  c: AssistServiceConfig,
  mode: 'mock' | 'live',
  credential: () => string | null,
): AssistProvider | null {
  if (mode === 'mock') return serverMock();
  if (c.provider.kind !== 'anthropic' || !c.provider.model || !c.pricing) return null;
  const apiKey = credential();
  if (!apiKey) return null;
  return new AnthropicProvider({
    apiKey,
    model: c.provider.model,
    pricing: c.pricing,
    maxOutputTokens: c.limits.maxOutputTokens,
  });
}

/**
 * Sprint 27 (DEV-Lab only, experimental): the Circuit Debugger's app side. On an explicit request
 * it gathers what the app already holds (the project, its editor checks, the running or failed
 * simulation, the program's build), builds the Engineering Context, runs the deterministic
 * debugger and asks the explanation gateway (the deterministic mock provider; no network) to
 * explain the findings. It reads state only: nothing here edits the project or starts a run or a
 * build.
 */
import {
  AssistGateway,
  EXPLAIN_CONTRACT,
  MockProvider,
  buildEngineeringContext,
  diagnose,
  type BuildInput,
  type ContextInput,
  type EngineeringContext,
  type FailureInput,
  type Finding,
  type GatewayResult,
} from '@tbi-lab/assist';
import type { ProjectDocument } from '@tbi-lab/domain';
import { getLocale, isMessageKey, isolateLtr, translate, type LocaleInfo } from '../i18n/i18n.js';
import type { MessageKey } from '../i18n/messages.en.js';
import type { BuildView } from '../programs/state.js';
import type { SimState } from '../sim/controller.js';
import { formatPower, formatResult } from '../sim/format.js';
import { warningsFor } from '../sim/ratings.js';
import { checksFor } from '../ui/checks.js';

export interface AnalysisSources {
  doc: ProjectDocument;
  sim: SimState;
  /** The board program's build state (null: no program, or no build service). */
  build: BuildView | null;
}

export interface Analysis {
  /** The document analysed (the panel says when the open project has changed since). */
  doc: ProjectDocument;
  input: ContextInput;
  context: EngineeringContext | null;
  contextBytes: number;
  findings: Finding[];
  /** The gateway's answer; null when nothing was sent (the context is over its bound). */
  explanation: GatewayResult | null;
  tooLarge: boolean;
}

/** The context input from the app's state: what the product has established, nothing more. */
export function gatherInput({ doc, sim, build }: AnalysisSources): ContextInput {
  let outcome: ContextInput['outcome'] = null;
  let failure: FailureInput | null = null;
  let ratings: ContextInput['ratings'] = [];
  if (sim.status === 'running') {
    if (sim.outcome.ok) {
      outcome = sim.outcome;
      ratings = warningsFor(doc, sim.outcome);
    } else failure = { kind: 'engine', error: sim.outcome.error };
  } else if (sim.status === 'failed') failure = sim.failure as FailureInput;
  const runtime = 'runtime' in sim ? sim.runtime : undefined;
  const observed = runtime
    ? Object.fromEntries(
        Object.entries(runtime.gpio).map(([g, l]) => [
          g,
          { mode: l.drive ? 'output' : 'input', level: l.level },
        ]),
      )
    : null;
  let buildInput: BuildInput | null = null;
  if (build) {
    const r = build.result;
    buildInput = {
      status:
        build.phase === 'current'
          ? 'current'
          : build.phase === 'failed'
            ? 'failed'
            : build.phase === 'building'
              ? 'building'
              : build.previous
                ? 'stale'
                : 'none',
      diagnostics: r?.diagnostics ?? [],
      ...(r?.features
        ? {
            features: {
              unsupported: r.features.unsupported,
              ...(r.features.requires ? { requires: r.features.requires } : {}),
              ...(r.features.inputReads ? { inputReads: r.features.inputReads } : {}),
            },
          }
        : {}),
    };
  }
  return {
    doc,
    checks: checksFor(doc),
    outcome,
    ratings,
    failure,
    build: buildInput,
    observed,
    // The browser does not know the runtime's announced capabilities: none is assumed.
    runtimeCapabilities: null,
  };
}

/** The mock's template renderer: the app's catalogs, numbers formatted for the locale. */
export function renderTemplate(
  key: string,
  params: Record<string, string | { value: number; unit: string }>,
  code: string,
): string {
  const locale: LocaleInfo = getLocale(code);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string') out[k] = isolateLtr(v);
    else
      out[k] = isolateLtr(
        v.unit === 'W'
          ? formatPower(locale, v.value)
          : formatResult(
              locale,
              v.value,
              v.unit === 'V' ? 'volt' : v.unit === 'Ω' ? 'ohm' : 'ampere',
            ),
      );
  }
  return isMessageKey(key) ? translate(locale, key as MessageKey, out) : '';
}

let gateway: AssistGateway | null = null;
/** One gateway per page (its rate and concurrency limits are the page's). */
export function assistGateway(): AssistGateway {
  gateway ??= new AssistGateway(
    new MockProvider({ render: renderTemplate, has: isMessageKey, delayMs: 300 }),
  );
  return gateway;
}

/** One analysis: context, deterministic findings, then the provider's explanation. */
export async function analyze(
  sources: AnalysisSources,
  locale: string,
  signal: AbortSignal,
): Promise<Analysis> {
  const input = gatherInput(sources);
  const built = buildEngineeringContext(input);
  if (!built.ok)
    return {
      doc: sources.doc,
      input,
      context: null,
      contextBytes: built.bytes,
      findings: [],
      explanation: null,
      tooLarge: true,
    };
  const findings = diagnose(built.context);
  const explanation = await assistGateway().explain(
    { contract: EXPLAIN_CONTRACT, locale, findings, context: built.context },
    signal,
  );
  return {
    doc: sources.doc,
    input,
    context: built.context,
    contextBytes: built.bytes,
    findings,
    explanation,
    tooLarge: false,
  };
}

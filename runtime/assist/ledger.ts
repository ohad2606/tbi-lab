/**
 * Sprint 28: the AI provider service's usage ledger and audit log (its state directory).
 *
 * - ledger.json: per UTC day, per principal: requests; per day: requests, tokens, charged USD.
 *   The monthly spending cap and token ceiling are checked against it BEFORE a call, with the
 *   request's worst case (every attempt at full output). A failed live attempt is charged its
 *   worst case (a provider may bill a refused or cut-off reply), so the cap cannot leak.
 * - audit-YYYY-MM-DD.jsonl: one line per decision: time, a short principal reference, action,
 *   outcome, tokens, charged USD, latency, context bytes. Never the context, the prompt, the
 *   reply, an email or a credential.
 * Both are pruned by age (retention days, configurable). Writes are atomic (rename).
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { join } from 'node:path';

interface Day {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  /** principal reference -> requests that day */
  by: Record<string, number>;
}

export interface AuditEvent {
  action: 'explain' | 'preview' | 'status';
  outcome: string;
  principal: string;
  inputTokens?: number;
  outputTokens?: number;
  usd?: number;
  latencyMs?: number;
  contextBytes?: number;
  attempts?: number;
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const month = (t: number) => new Date(t).toISOString().slice(0, 7);
/** Short, non-reversible reference to an (already opaque) principal for the audit log. */
export const principalRef = (p: string) => p.slice(0, 8);

export class Ledger {
  private days: Record<string, Day> = {};
  private readonly file: string;

  constructor(
    private readonly dir: string,
    private readonly retention: { auditDays: number; ledgerDays: number },
    private readonly now: () => number = Date.now,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, 'ledger.json');
    if (existsSync(this.file))
      this.days = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, Day>;
    this.prune();
  }

  private save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.days), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Remove ledger days and audit files older than their retention. */
  prune(): void {
    const t = this.now();
    const cut = (days: number) => day(t - days * 86_400_000);
    const ledgerCut = cut(this.retention.ledgerDays);
    for (const d of Object.keys(this.days)) if (d < ledgerCut) delete this.days[d];
    const auditCut = cut(this.retention.auditDays);
    for (const f of readdirSync(this.dir)) {
      const m = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
      if (m && m[1]! < auditCut) rmSync(join(this.dir, f), { force: true });
    }
    this.save();
  }

  requestsToday(principal: string): number {
    return this.days[day(this.now())]?.by[principalRef(principal)] ?? 0;
  }

  monthTotals(): { usd: number; tokens: number } {
    const m = month(this.now());
    let usd = 0;
    let tokens = 0;
    for (const [d, v] of Object.entries(this.days))
      if (d.startsWith(m)) {
        usd += v.usd;
        tokens += v.inputTokens + v.outputTokens;
      }
    return { usd, tokens };
  }

  record(principal: string, use: { inputTokens: number; outputTokens: number; usd: number }): void {
    const d = (this.days[day(this.now())] ??= {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      usd: 0,
      by: {},
    });
    d.requests += 1;
    d.inputTokens += use.inputTokens;
    d.outputTokens += use.outputTokens;
    d.usd += use.usd;
    const ref = principalRef(principal);
    d.by[ref] = (d.by[ref] ?? 0) + 1;
    this.save();
  }

  audit(e: AuditEvent): void {
    const line = {
      t: new Date(this.now()).toISOString(),
      ...e,
      principal: principalRef(e.principal),
    };
    appendFileSync(join(this.dir, `audit-${day(this.now())}.jsonl`), `${JSON.stringify(line)}\n`, {
      mode: 0o600,
    });
  }
}

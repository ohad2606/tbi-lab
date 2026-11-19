/** Test-only provider with the call shape of the mock: scripted spend per call, can fail, can be slow. Never imported by production code. */
export class FakeSpendProvider {
  usdMicro: number;
  mode: 'ok' | 'fail' = 'ok';
  /** when set, each call waits for this promise (lets tests interleave parallel calls) */
  gate: Promise<void> | null = null;
  calls = 0;
  /** every prompt and reply seen, for the privacy scan */
  readonly seen: string[] = [];

  constructor(usdMicro: number) {
    this.usdMicro = usdMicro;
  }

  async call(prompt: string): Promise<{ reply: string; usdMicro: number }> {
    this.calls += 1;
    this.seen.push(prompt);
    if (this.gate) await this.gate;
    if (this.mode === 'fail') throw new Error('provider failed (scripted)');
    const reply = `reply to ${prompt.length} chars #${this.calls}`;
    this.seen.push(reply);
    return { reply, usdMicro: this.usdMicro };
  }
}

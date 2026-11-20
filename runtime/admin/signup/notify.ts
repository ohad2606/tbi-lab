/**
 * TBI-022: the owner's Telegram notification. Minimal personal data: the name, the role and the
 * admin link; never the address. `fetch` and the token reader are injected. The token is in the
 * request URL by Telegram's design, so errors never carry the URL or the response body.
 */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

export interface SignupNotifier {
  notify(n: { name: string; role: string }): Promise<void>;
}

export interface TelegramConfig {
  /** Reads the bot token (a root-owned file in deployment). */
  readToken: () => Promise<string>;
  chatId: string;
  adminLink: string;
  fetch: FetchLike;
  timeoutMs?: number;
}

export class NotifyError extends Error {}

export class TelegramNotifier implements SignupNotifier {
  constructor(private readonly c: TelegramConfig) {}

  async notify(n: { name: string; role: string }): Promise<void> {
    const token = (await this.c.readToken()).trim();
    if (!/^\d{3,20}:[A-Za-z0-9_-]{20,}$/.test(token)) throw new NotifyError('bad_token');
    const text = `New TBI Lab sign-up request: ${n.name} (${n.role}). Review: ${this.c.adminLink}`;
    let res;
    try {
      res = await this.c.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: this.c.chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(this.c.timeoutMs ?? 10_000),
      });
    } catch {
      throw new NotifyError('network');
    }
    if (!res.ok) throw new NotifyError(`http_${res.status}`);
  }
}

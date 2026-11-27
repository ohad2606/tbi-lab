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

/** A Telegram bot token's shape; checked at intake start and again before every send. */
export const TELEGRAM_TOKEN_RE = /^\d{3,20}:[A-Za-z0-9_-]{20,}$/;

/** Name / role lengths in the notification (code points); the store keeps the full values. */
export const NOTIFY_NAME_MAX = 40;
export const NOTIFY_ROLE_MAX = 60;

/** Links with a scheme or `www.`, and bare domain-like tokens (`host.tld/...`) that Telegram would linkify. */
const URL_RE = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S*/gi;
const DOMAIN_RE =
  /(?<![\p{L}\p{N}_-])[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*\.\p{L}{2,}(?![\p{L}\p{N}_-])(?:[/:?#]\S*)?/giu;

function clip(s: string, max: number): string {
  const cps = [...s];
  return cps.length <= max ? s : `${cps.slice(0, max - 1).join('')}…`;
}

/** Applicant-controlled text for a third party: links removed, then truncated. */
function clean(s: string, max: number): string {
  const t = s.replace(URL_RE, '[link]').replace(DOMAIN_RE, '[link]').replace(/\s+/g, ' ').trim();
  return clip(t, max);
}

/** The notification text (plain text; no parse_mode, so no markup). */
export function telegramText(n: { name: string; role: string }, adminLink: string): string {
  return `New TBI Lab sign-up request: ${clean(n.name, NOTIFY_NAME_MAX)} (${clean(n.role, NOTIFY_ROLE_MAX)}). Review: ${adminLink}`;
}

export class TelegramNotifier implements SignupNotifier {
  constructor(private readonly c: TelegramConfig) {}

  notify(n: { name: string; role: string }): Promise<void> {
    return this.send(telegramText(n, this.c.adminLink));
  }

  /** One plain-text message to the owner's chat. */
  async send(text: string): Promise<void> {
    const token = (await this.c.readToken()).trim();
    if (!TELEGRAM_TOKEN_RE.test(token)) throw new NotifyError('bad_token');
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

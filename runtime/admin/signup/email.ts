/**
 * TBI-022: the approval email (HE + EN) and its sender through the Resend HTTP API.
 * Plain text only (no HTML: no injection surface). URLs and the from address come from config;
 * the API key is read from a file by an injected reader at send time. Nothing here knows an
 * owner's name. The wording is a draft of the owner-approved mail: the owner confirms the final
 * text before enabling (see the design note, open questions).
 */
import type { FetchLike } from './notify.js';

export interface EmailConfig {
  /** `Name <address>` or a bare address; the sending-domain address, from config. */
  from: string;
  labUrl: string;
  /** Reply-To for feedback (defaults to `from`). */
  replyTo?: string;
}

export interface Mail {
  subject: string;
  text: string;
}

/** The name goes into the greeting only; it was sanitised on intake (no control characters). */
export function approvalEmail(
  lang: 'he' | 'en',
  name: string,
  c: Pick<EmailConfig, 'labUrl'>,
): Mail {
  if (lang === 'he') {
    return {
      subject: 'הגישה שלך ל-TBI Lab אושרה',
      text: [
        `שלום ${name},`,
        '',
        'תודה שנרשמת. הבקשה שלך אושרה ויש לך גישה למעבדת TBI Lab (גרסת אלפא).',
        '',
        `כניסה למעבדה: ${c.labUrl}`,
        '',
        'כדי להיכנס:',
        '- התחברו עם אותו חשבון Google שבו נרשמתם.',
        '- השתמשו ב-Chrome או ב-Edge במחשב (שולחני). אין תמיכה בטלפון או בטאבלט.',
        '',
        'שימו לב: גרסת האלפא מוגבלת במספר המקומות, והמעבדה עדיין בפיתוח.',
        'נשמח לקבל משוב: פשוט השיבו למייל הזה.',
        '',
        'צוות TBI Lab',
      ].join('\n'),
    };
  }
  return {
    subject: 'Your TBI Lab access is approved',
    text: [
      `Hello ${name},`,
      '',
      'Thank you for signing up. Your request is approved and you now have access to the TBI Lab alpha.',
      '',
      `Open the lab: ${c.labUrl}`,
      '',
      'To sign in:',
      '- Use the same Google account you signed up with.',
      '- Use desktop Chrome or Edge on a computer. Phones and tablets are not supported.',
      '',
      'Please note: the alpha has a limited number of places, and the lab is still in development.',
      'We would love your feedback: just reply to this email.',
      '',
      'The TBI Lab team',
    ].join('\n'),
  };
}

export interface EmailSender {
  sendApproval(to: { email: string; name: string; lang: 'he' | 'en'; id: string }): Promise<void>;
}

export class EmailError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface ResendConfig extends EmailConfig {
  /** Reads the sending-only API key (a root-owned file in deployment). */
  readKey: () => Promise<string>;
  fetch: FetchLike;
  timeoutMs?: number;
}

export class ResendSender implements EmailSender {
  constructor(private readonly c: ResendConfig) {}

  async sendApproval(to: {
    email: string;
    name: string;
    lang: 'he' | 'en';
    id: string;
  }): Promise<void> {
    const key = (await this.c.readKey()).trim();
    if (!/^re_[A-Za-z0-9_-]{8,}$/.test(key)) throw new EmailError('bad_key');
    const mail = approvalEmail(to.lang, to.name, this.c);
    let res;
    try {
      res = await this.c.fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          // Resend de-duplicates by this key for 24 h: a retry of an ambiguous send cannot double up.
          'idempotency-key': `signup-approval-${to.id}`,
        },
        body: JSON.stringify({
          from: this.c.from,
          to: [to.email],
          reply_to: this.c.replyTo ?? this.c.from,
          subject: mail.subject,
          text: mail.text,
        }),
        signal: AbortSignal.timeout(this.c.timeoutMs ?? 15_000),
      });
    } catch {
      throw new EmailError('network');
    }
    if (!res.ok) throw new EmailError(`http_${res.status}`);
  }
}

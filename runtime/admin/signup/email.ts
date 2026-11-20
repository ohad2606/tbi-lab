/**
 * TBI-022: the approval email (HE + EN) and its sender through the Resend HTTP API.
 * Plain text only (no HTML: no injection surface). URLs and the from address come from config;
 * the API key is read from a file by an injected reader at send time. Nothing here knows an
 * owner's name.  The Hebrew wording is the owner-approved text; the English is a translation pending owner OK.
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

/** The first whitespace-separated token of the (already sanitised) name; the greeting uses only it. */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? '';
}

/** Gmail addresses need no hint about signing in with a Google account. */
function isGmail(email: string): boolean {
  return /@gmail\.com$/i.test(email.trim());
}

/**
 * HE: the owner-approved text (2026-11-20), verbatim. EN: translation pending owner OK.
 * The sign-off line is pending owner confirmation. The extra paragraph about a non-Google address
 * appears only when the address is not @gmail.com.
 */
export function approvalEmail(
  lang: 'he' | 'en',
  to: { name: string; email: string },
  c: Pick<EmailConfig, 'labUrl'>,
): Mail {
  const first = firstName(to.name);
  const extra = !isGmail(to.email);
  if (lang === 'he') {
    return {
      subject: 'ההרשמה שלך ל-TBI Lab אושרה',
      text: [
        `שלום ${first},`,
        '',
        'תודה שנרשמת לבדיקות של TBI Lab. ההרשמה שלך אושרה ואפשר להיכנס כבר עכשיו:',
        c.labUrl,
        '',
        'כמה דברים חשובים:',
        '• הכניסה היא עם חשבון Google. צריך להתחבר עם אותה כתובת מייל שאיתה נרשמת.',
        '• המעבדה עובדת במחשב, בדפדפן Chrome או Edge.',
        '• זו גרסת Alpha ומספר המקומות בו-זמנית מוגבל. אם כל המקומות תפוסים, כדאי לנסות שוב מאוחר יותר.',
        '',
        ...(extra
          ? [
              'אם הכתובת שאיתה נרשמת אינה חשבון Google והכניסה לא מצליחה, אפשר להשיב למייל הזה עם כתובת Gmail, ואעדכן אותה.',
              '',
            ]
          : []),
        'כל משוב, תקלה או רעיון יעזרו לנו מאוד. אפשר פשוט להשיב למייל הזה.',
        '',
        'בהצלחה,',
        'צוות TBI Lab', // sign-off pending owner confirmation
      ].join('\n'),
    };
  }
  // English: translation pending owner OK.
  return {
    subject: "You're approved for TBI Lab",
    text: [
      `Hi ${first},`,
      '',
      'Thanks for signing up to test TBI Lab. Your registration is approved and you can sign in now:',
      c.labUrl,
      '',
      'A few important things:',
      '• Sign in with Google, using the same email address you registered with.',
      '• The lab works on a computer, in Chrome or Edge.',
      "• This is an Alpha with a limited number of simultaneous places. If they're all taken, please try again a bit later.",
      '',
      ...(extra
        ? [
            "If the address you registered with isn't a Google account and sign-in fails, reply to this email with a Gmail address and we'll update it.",
            '',
          ]
        : []),
      'Any feedback, bug or idea helps us a lot. Just reply to this email.',
      '',
      'Good luck,',
      'The TBI Lab team', // sign-off pending owner confirmation
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
    const mail = approvalEmail(to.lang, to, this.c);
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

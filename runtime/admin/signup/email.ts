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

/** The first whitespace-separated token of the (already sanitised) name. */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? '';
}

/** Longest first-name token used in a greeting; a longer one gets the generic greeting. */
export const GREETING_NAME_MAX = 40;
/**
 * A first name: Unicode letters (with their combining marks), optionally joined by single
 * hyphens (incl. the Hebrew maqaf) or apostrophes (incl. U+2019 and the Hebrew geresh). No digits,
 * dots, colons, slashes, `@` or anything else: nothing a mail client can turn into a link.
 */
const GREETING_NAME_RE = /^[\p{L}\p{M}]+(?:[-\u2010\u2011\u05BE'\u2019\u05F3][\p{L}\p{M}]+)*$/u;

/**
 * The name the greeting may show, or null for the generic greeting. The name is sign-up input
 * (untrusted): only a plain first-name token is put into a company-branded mail, so a "name" like
 * `https://evil.example/login`, `evil.example` or an address never becomes a clickable link.
 */
export function greetingName(name: string): string | null {
  const first = firstName(name);
  if ([...first].length > GREETING_NAME_MAX || !GREETING_NAME_RE.test(first)) return null;
  // `www` + letters is not a link by itself, but some clients linkify it loosely: refuse it.
  if (/^www/i.test(first)) return null;
  return first;
}

/** Consumer Google mail domains: these addresses need no hint about signing in with a Google account. */
export const GOOGLE_MAIL_DOMAINS: readonly string[] = ['gmail.com', 'googlemail.com'];

function isGoogleMail(email: string): boolean {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  return at > 0 && GOOGLE_MAIL_DOMAINS.includes(e.slice(at + 1));
}

/**
 * HE: the owner-approved text (2026-11-20), with the owner's change of 2026-11-22 (company voice:
 * "ונעדכן", we). EN: translation pending owner OK. Sign-off approved by the owner 2026-11-22. The extra paragraph about a non-Google address
 * appears only when the address is not in GOOGLE_MAIL_DOMAINS.
 */
export function approvalEmail(
  lang: 'he' | 'en',
  to: { name: string; email: string },
  c: Pick<EmailConfig, 'labUrl'>,
): Mail {
  // Only a plain first-name token, else the generic greeting ("שלום," / "Hi,").
  const first = greetingName(to.name);
  const extra = !isGoogleMail(to.email);
  if (lang === 'he') {
    return {
      subject: 'ההרשמה שלך ל-TBI Lab אושרה',
      text: [
        first ? `שלום ${first},` : 'שלום,',
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
              'אם הכתובת שאיתה נרשמת אינה חשבון Google והכניסה לא מצליחה, אפשר להשיב למייל הזה עם כתובת Gmail, ונעדכן אותה.',
              '',
            ]
          : []),
        'כל משוב, תקלה או רעיון יעזרו לנו מאוד. אפשר פשוט להשיב למייל הזה.',
        '',
        'בהצלחה,',
        'צוות TBI Lab', // sign-off approved by the owner 2026-11-22
      ].join('\n'),
    };
  }
  // English: translation pending owner OK.
  return {
    subject: "You're approved for TBI Lab",
    text: [
      first ? `Hi ${first},` : 'Hi,',
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
      'The TBI Lab team', // sign-off approved by the owner 2026-11-22
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

/** A sending-only mail key's shape; checked before every send (and once at admin start, warning only). */
export const RESEND_KEY_RE = /^re_[A-Za-z0-9_-]{8,}$/;

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
    if (!RESEND_KEY_RE.test(key)) throw new EmailError('bad_key');
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

/**
 * BETA-G1 flip-mode site copy: with `signupVerify` the home, alpha, FAQ and accessibility pages describe the
 * email-confirmation sign-up (design/G1-AUTO-VERIFY-COPY-DRAFT.md section 3) and carry the accessibility wording the
 * owner approved on 2026-11-27. Byte identity with the option off is checked in signup-verify.test.mjs. Privacy and
 * consent texts wait for the lawyer and must not change here.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { buildSite } from '../build.mjs';
import { content } from '../content.mjs';
import { VERIFY_TOKEN_TTL_MS } from '../../runtime/admin/signup/verify.ts';

const walk = (d) =>
  readdirSync(d)
    .sort()
    .flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
const dirs = [];
const build = (o) => {
  dirs.push(mkdtempSync(join(tmpdir(), 'tbi-vf-copy-')));
  return buildSite(dirs.at(-1), o);
};
const html = (o, l, p = '') => readFileSync(join(o, l, p, 'index.html'), 'utf8');
/** What a reader gets: tags removed (block ends become a space), entities decoded, spaces collapsed. */
const read = (h) =>
  h
    .replace(/<\/(?:p|li|h\d|ul|section|div)>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
const main = (h) => h.match(/<main[^>]*>([\s\S]*)<\/main>/)[1];
const section = (h, id) =>
  [...h.matchAll(/<section>[\s\S]*?<\/section>/g)]
    .map((m) => m[0])
    .find((s) => s.includes(`id="${id}"`));
const items = (s) => [...s.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => read(m[1]));
const paragraphs = (s) => [...s.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => read(m[1]));

let off;
let on;
beforeAll(() => {
  off = build({ signupEnabled: true });
  on = build({ signupEnabled: true, signupVerify: true });
  return () => dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const COPY = {
  en: {
    home: 'TBI Lab is in an early access program. It is free and places are limited. Sign up, confirm your email, and you are in. On busy days it may take longer. Read how it works on the Alpha program page.',
    selectionH: 'How you get access',
    selection: [
      'Sending the form is not enough: you also confirm your email address with a link we send you.',
      'After you confirm, we set up your access and email you when you can sign in.',
      'Places are limited. On busy days it may take longer.',
      'Only accounts that we have activated can sign in to the Lab.',
    ],
    applyH: 'How to sign up',
    apply: [
      'Fill in the sign-up form on this site with the button below, using the email address of your Google account.',
      'Sign up, confirm your email, and you are in. On busy days it may take longer. We will email you when you can sign in.',
    ],
    accessH: 'How do I get access?',
    access:
      'Fill in the sign-up form with the email address of your Google account, open the link we email you and press the confirm button. Then we set up your access and email you when you can sign in. Places are limited, and on busy days it may take longer. Only activated accounts can sign in.',
    noMailH: 'I didn’t get the confirmation email. What can I do?',
    noMail:
      'Check your spam folder. Then reload the sign-up page and send the form again with the same address. A confirmation link works for 24 hours.',
    a11y: [
      'We develop TBI Lab according to the WCAG 2.2 guidelines at level AA. The full check is not yet complete.',
      'Known limitations right now:',
      'Encountered a barrier? Write to support@tbi-tech.net and we will take care of it.',
    ],
    limits: [
      'A screen at least 1024 pixels wide is required.',
      'Testing with a screen reader has not yet been done.',
    ],
    checkedH: 'What was checked on this website',
    notCheckedH: 'What was not checked on this website',
    manual: [
      /reviewed manually/i,
      /Applying does not give access/i,
      /Approved applicants/i,
      /gradually/i,
      /waiting list/i,
      /Google Forms/i,
    ],
  },
  he: {
    home: 'TBI Lab נמצא בתוכנית גישה מוקדמת. זה ללא עלות ומספר המקומות מוגבל. נרשמים, מאשרים את המייל ונכנסים. בימים עמוסים זה עלול לקחת יותר זמן. איך זה עובד מוסבר בעמוד תוכנית אלפא.',
    selectionH: 'איך מקבלים גישה',
    selection: [
      'שליחת הטופס לבדה לא מספיקה: צריך גם לאשר את כתובת המייל בקישור שנשלח אליכם.',
      'אחרי האישור נפעיל לכם את הגישה ונשלח מייל כשאפשר להיכנס.',
      'מספר המקומות מוגבל. בימים עמוסים זה עלול לקחת יותר זמן.',
      'רק חשבונות שהפעלנו יכולים להיכנס למעבדה.',
    ],
    applyH: 'איך נרשמים',
    apply: [
      'ממלאים את טופס ההרשמה באתר בכפתור שלמטה, עם כתובת המייל של חשבון Google שלכם.',
      'נרשמים, מאשרים את המייל ונכנסים. בימים עמוסים זה עלול לקחת יותר זמן. נשלח מייל כשאפשר להיכנס.',
    ],
    accessH: 'איך מקבלים גישה?',
    access:
      'ממלאים את טופס ההרשמה עם כתובת המייל של חשבון Google שלכם, פותחים את הקישור שנשלח למייל ולוחצים על כפתור האישור. אחר כך נפעיל לכם את הגישה ונשלח מייל כשאפשר להיכנס. מספר המקומות מוגבל, ובימים עמוסים זה עלול לקחת יותר זמן. רק חשבונות שהופעלו יכולים להיכנס.',
    noMailH: 'לא קיבלתי את מייל האישור. מה עושים?',
    noMail:
      'בדקו בתיקיית הספאם. אם לא נמצא, טענו מחדש את דף ההרשמה ושלחו שוב את הטופס עם אותה כתובת. קישור אישור תקף ל-24 שעות.',
    // Owner directive 2026-11-27 07:40, item 2: verbatim.
    a11y: [
      'אנחנו מפתחים את TBI Lab לפי הנחיות WCAG 2.2 ברמה AA. הבדיקה המלאה עדיין לא הושלמה.',
      'מגבלות ידועות כרגע:',
      'נתקלתם בחסם? כתבו ל-support@tbi-tech.net ונטפל בזה.',
    ],
    limits: ['נדרש מסך ברוחב 1024 פיקסלים לפחות.', 'בדיקה עם קורא מסך עדיין לא בוצעה.'],
    checkedH: 'מה נבדק באתר הזה',
    notCheckedH: 'מה לא נבדק באתר הזה',
    manual: [
      /ידנית/,
      /אינה מקנה גישה/,
      /מי שיאושר/,
      /בהדרגה/,
      /רשימת (ה)?המתנה/,
      /מועמדות/,
      /Google Forms/,
    ],
  },
};
const CHANGED = ['', 'alpha', 'faq', 'accessibility'];
const h2 = (s) => read(s.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)[1]);

describe.each(['he', 'en'])('signupVerify copy: %s', (l) => {
  const c = COPY[l];
  it('accessibility: the description covers the product statement in meta and Open Graph', () => {
    const h = html(on, l, 'accessibility');
    const meta = h.match(/<meta name="description" content="([^"]*)">/)[1];
    expect(meta).toContain('TBI Lab');
    expect(meta).toBe(content[l].signupVerify.descriptions.accessibility);
    expect(h).toContain(`<meta property="og:description" content="${meta}">`);
  });
  it('home: early-access paragraph', () => {
    expect(paragraphs(section(html(on, l), 'status'))).toEqual([c.home]);
  });
  it('alpha: both headings, the access list and the own-form steps', () => {
    const h = html(on, l, 'alpha');
    const sel = section(h, 'selection');
    expect(h2(sel)).toBe(c.selectionH);
    expect(items(sel)).toEqual(c.selection);
    const how = section(h, 'how-to-apply');
    expect(h2(how)).toBe(c.applyH);
    expect(paragraphs(how).slice(0, 2)).toEqual(c.apply);
    expect(how).toContain(`class="btn btn-primary" href="/${l}/signup/"`);
  });
  it('faq: the access answer and the no-email item right after it', () => {
    const h = html(on, l, 'faq');
    for (const [id, head, text] of [
      ['q-access', c.accessH, c.access],
      ['q-no-email', c.noMailH, c.noMail],
    ]) {
      const s = section(h, id);
      expect(h2(s)).toBe(head);
      expect(paragraphs(s)).toEqual([text]);
    }
    const ids = [...h.matchAll(/<h2 id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual([
      'q-free',
      'q-access',
      'q-no-email',
      'q-need',
      'q-board',
      'q-data',
      'q-lang',
    ]);
  });
  it('faq: the 24 hours in the answer is the link validity in the code', () => {
    expect(VERIFY_TOKEN_TTL_MS).toBe(24 * 3_600_000);
  });
  it('accessibility: the approved wording, a real list and a mailto link, in this order', () => {
    const h = html(on, l, 'accessibility');
    const s = section(h, 'statement');
    expect(s).toMatch(/<p>[\s\S]*<\/p>\s*<p>[\s\S]*<\/p>\s*<ul>[\s\S]*<\/ul>\s*<p>[\s\S]*<\/p>/);
    expect(paragraphs(s)).toEqual(c.a11y);
    expect(items(s)).toEqual(c.limits);
    expect(s).toContain(
      '<a href="mailto:support@tbi-tech.net"><span dir="ltr">support@tbi-tech.net</span></a>',
    );
    if (l === 'he')
      for (const t of ['TBI Lab', 'WCAG 2.2', 'AA'])
        expect(s).toContain(`<span dir="ltr" lang="en">${t}</span>`);
    const ids = [...h.matchAll(/<h2 id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(['statement', 'checked', 'not-checked']);
  });
  it('accessibility: the website checks stay, labelled as such; nothing contradicts or claims compliance', () => {
    const h = main(html(on, l, 'accessibility'));
    expect(h2(section(h, 'checked'))).toBe(c.checkedH);
    expect(h2(section(h, 'not-checked'))).toBe(c.notCheckedH);
    for (const id of ['checked', 'not-checked']) {
      const old = section(html(off, l, 'accessibility'), id);
      const body = (s) => s.replace(/<h2[\s\S]*?<\/h2>/, '');
      expect(body(section(h, id))).toBe(body(old));
    }
    expect(read(h)).not.toMatch(/separate product|מוצר נפרד/);
    expect(read(h)).not.toMatch(
      /compl(?:ies|iant|iance)|we (?:meet|conform)|עומדים בתקן|תואם לתקן/i,
    );
  });
  it('no page outside privacy and the sign-up form text still describes manual approval', () => {
    for (const p of [...CHANGED, 'product']) {
      const t = read(html(on, l, p));
      for (const re of c.manual) expect(t, `${p} ${re}`).not.toMatch(re);
    }
  });
});

describe('signupVerify copy: scope', () => {
  it('changes exactly the home, alpha, FAQ, accessibility and sign-up pages and the module', () => {
    const changed = walk(on)
      .map((f) => relative(on, f))
      .filter((f) => !readFileSync(join(on, f)).equals(readFileSync(join(off, f))));
    expect(changed.sort()).toEqual(
      [
        'assets/signup.mjs',
        ...['he', 'en'].flatMap((l) => [...CHANGED, 'signup'].map((p) => join(l, p, 'index.html'))),
      ].sort(),
    );
  });
  it('privacy pages and the in-form privacy and consent text are untouched (lawyer, G4)', () => {
    for (const l of ['he', 'en']) {
      expect(html(on, l, 'privacy')).toBe(html(off, l, 'privacy'));
      const legal = (h) => h.match(/<h2 class="small-h">[\s\S]*?<p><button type="submit"/)[0];
      expect(legal(html(on, l, 'signup'))).toBe(legal(html(off, l, 'signup')));
    }
  });
  it('the --signup-verify preview shows the same site as the flip (no Google Forms mixed in)', () => {
    const preview = build({ signupPreview: true, signupVerify: true });
    const files = walk(on).map((f) => relative(on, f));
    expect(walk(preview).map((f) => relative(preview, f))).toEqual(files);
    for (const f of files)
      expect(readFileSync(join(preview, f)).equals(readFileSync(join(on, f))), f).toBe(true);
  });
  it('every section override points at a section that exists (HE and EN)', () => {
    for (const l of ['he', 'en'])
      for (const [page, patch] of Object.entries(content[l].signupVerify.pages)) {
        const ids = content[l].pages[page].sections.map((s) => s.id);
        for (const id of Object.keys(patch)) expect(ids, `${l}/${page}`).toContain(id);
      }
  });
});

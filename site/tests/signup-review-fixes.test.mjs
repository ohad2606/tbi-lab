/**
 * BETA-G1 s10: Fable review of PR #94, site side. Findings 1 (heardFrom is optional free text, label as in the
 * existing form), 8 (flag off = no sign-up page, existing pages byte-identical to co/main), 9 (client email check is
 * the server's), 16a-c and 17 (Hebrew page details). The client/server timing contract (finding 7) is in
 * signup-contract.test.mjs.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { buildSite } from '../build.mjs';
import { content } from '../content.mjs';
import { normalizeEmail, validate } from '../signup.mjs';
import { normalizeAddEmail } from '../../runtime/admin/accounts.ts';
import { validateSignup } from '../../runtime/admin/signup/validate.ts';

/**
 * sha256 of every HTML page of `node site/build.mjs` at origin/co/main 81d1526 (taken from a build of that commit,
 * not of this branch). With the sign-up flag off this branch must produce exactly these pages and no others.
 */
const CO_MAIN_PAGES = {
  'index.html': '05cd99dd4c17d2ecb92a00d475ada250080fd71cc17703ed6b467932a750ce66',
  'en/index.html': '5c20d23bcbfca72d0b0f1a497e93d130bb59e2b8908b906abb99e4cb02da00ac',
  'en/product/index.html': '3970c0d012aaf5a6cfe70405bcc8615b91c447cb1a4097c99d856b6ca5f8ba96',
  'en/alpha/index.html': 'c34ea9b858b429950fed3c35eb00d22cc08118596b6e574e0fe0f84bf85b39a9',
  'en/faq/index.html': 'd110e287edb9e3ac9a78f37e009a5744173520fa3f718957fe95dd9d4a6eb8ce',
  'en/privacy/index.html': 'd6736c13987bb59e708dcd99e43fc1e17691df0aaa787eff9c7cda5f5aef631e',
  'en/accessibility/index.html': 'adbb5ad3b8806ef4f8b03b468347456281ed020b070314d71d7c734f6dc9161c',
  'he/index.html': 'ee55f82eb766ff214ef1757bae922d44178f77ae24b1b42ccb70b40743e58ab1',
  'he/product/index.html': 'ff0551e2e705bf2fdfd6de7c559dd24bc5bdd2393c0198191296b96096746d32',
  'he/alpha/index.html': '9fd36fb4d932ea76b36b156604257bae11d382a22af5913b113c20441f32cdb6',
  'he/faq/index.html': 'ee8e60d7768210f4b5ae3bd5eef97869303c8e107fb5248f9542185e0cc6decb',
  'he/privacy/index.html': '5e69443504c2b807ea76095f03f5ab7af1de78ab93135584aeb77a80e3e2f299',
  'he/accessibility/index.html': 'af41cad86952c0aedecac9d819e4fd0afc8fce9b0efb8f4477d87c72d4636f33',
};
/** Every non-HTML file of the same co/main build (site.css is compared by name only: it gains sign-up styles). */
const CO_MAIN_ASSETS = [
  'assets/favicon-32.png',
  'assets/favicon.ico',
  'assets/fonts/OFL-Heebo.txt',
  'assets/fonts/heebo-hebrew-wght-normal.woff2',
  'assets/fonts/heebo-latin-wght-normal.woff2',
  'assets/images/distance-alarm-3d.png',
  'assets/images/distance-alarm-circuit.png',
  'assets/images/lcd-hello-schematic.png',
  'assets/og/tbi-lab-preview.png',
  'assets/site.css',
  'assets/tbi-lab-logo.png',
];

function files(dir) {
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

let off;
let preview;
const page = (o, l) => readFileSync(join(o, l, 'signup', 'index.html'), 'utf8');
beforeAll(() => {
  off = buildSite(mkdtempSync(join(tmpdir(), 'tbi-su-off-')));
  preview = buildSite(mkdtempSync(join(tmpdir(), 'tbi-su-pre-')), { signupPreview: true });
});

describe('finding 8: flag off builds no sign-up page', () => {
  it('no /he|en/signup/ and no assets/signup.mjs', () => {
    for (const l of ['he', 'en']) expect(existsSync(join(off, l, 'signup'))).toBe(false);
    expect(existsSync(join(off, 'assets', 'signup.mjs'))).toBe(false);
  });
  it('exactly the co/main files; every page byte-identical to co/main', () => {
    expect(files(off)).toEqual([...Object.keys(CO_MAIN_PAGES), ...CO_MAIN_ASSETS].sort());
    for (const [f, h] of Object.entries(CO_MAIN_PAGES)) expect(sha(join(off, f)), f).toBe(h);
  });
  it('no sign-up link, form token or intake base anywhere in dist', () => {
    for (const f of files(off).filter((x) => /\.(html|css|mjs|txt)$/.test(x))) {
      const t = readFileSync(join(off, f), 'utf8');
      expect(t, f).not.toContain('/signup');
      expect(t, f).not.toContain('form-token');
      expect(t, f).not.toContain('data-api');
      expect(t, f).not.toContain('signup.mjs');
    }
  });
  it('the explicit preview build (e2e only) adds the noindex, unlinked page and leaves every other page unchanged', () => {
    for (const l of ['he', 'en']) {
      expect(page(preview, l)).toContain('<meta name="robots" content="noindex">');
      expect(page(preview, l)).toContain(
        '<script type="module" src="/assets/signup.mjs"></script>',
      );
    }
    expect(existsSync(join(preview, 'assets', 'signup.mjs'))).toBe(true);
    for (const [f, h] of Object.entries(CO_MAIN_PAGES)) expect(sha(join(preview, f)), f).toBe(h);
  });
});

describe('gate G1 a11y minors: heard hint, email message, visible sending text', () => {
  const HINT = { he: 'עד 80 תווים.', en: 'Up to 80 characters.' };
  const CHARS = {
    he: 'השתמשו באותיות באנגלית, בספרות ובסימנים.',
    en: 'Use English letters, digits and symbols.',
  };
  it.each(['he', 'en'])('%s: the heard input is described by a visible length hint', (l) => {
    const h = page(preview, l);
    expect(h).toContain(`<p class="hint-text" id="su-hint-heard">${HINT[l]}</p>`);
    expect(h.match(/<input[^>]*id="su-heard"[^>]*>/)[0]).toContain(
      'aria-describedby="su-hint-heard"',
    );
  });
  it.each(['he', 'en'])('%s: the invalid-email message names the accepted characters', (l) => {
    expect(content[l].signup.errEmail.endsWith(` ${CHARS[l]}`)).toBe(true);
    expect(normalizeEmail('דנה@example.com')).toBe(null);
  });
  it.each(['he', 'en'])('%s: a hidden, aria-hidden sending line follows the button', (l) => {
    expect(page(preview, l)).toContain(
      `</button></p>\n<p id="su-sending" class="hint-text" aria-hidden="true" hidden>${content[l].signup.statusSending}</p>\n</form>`,
    );
  });
});

describe('finding 1: "how did you hear about us" is optional free text', () => {
  it.each(['he', 'en'])('%s: a text input, maxlength 80, autocomplete off, not required', (l) => {
    const h = page(preview, l);
    expect(h).not.toMatch(/<select[^>]*id="su-heard"/);
    const input = h.match(/<input[^>]*id="su-heard"[^>]*>/)[0];
    for (const a of [
      'type="text"',
      'name="heardFrom"',
      'maxlength="80"',
      'autocomplete="off"',
      'dir="auto"',
    ])
      expect(input).toContain(a);
    expect(input).not.toMatch(/required/);
    expect(h).toMatch(/<label for="su-heard">[^<]*<span class="optional">/);
  });
  it('labels: Hebrew wording as in the existing form; no "all fields are required" claim', () => {
    expect(content.he.signup.heard).toBe('איך הגעת אלינו?');
    expect(content.en.signup.heard).toBe('How did you hear about us?');
    for (const l of ['he', 'en']) {
      const h = page(preview, l);
      expect(h).not.toContain('כל השדות הם חובה');
      expect(h).not.toContain('All fields are required.');
      expect(content[l].signup.heards).toBeUndefined();
      expect(content[l].signup.heardPick).toBeUndefined();
      expect(h).toContain(content[l].signup.optional);
    }
  });
  it('client: an empty answer is fine; more than 80 characters (code points, like the server) is not', () => {
    const ok = { name: 'N', email: 'a@b.co', role: 'Student', age: true, consent: true };
    expect(validate({ ...ok, heard: '' })).toEqual([]);
    expect(validate({ ...ok })).toEqual([]);
    expect(validate({ ...ok, heard: 'x'.repeat(80) })).toEqual([]);
    expect(validate({ ...ok, heard: '😀'.repeat(80) })).toEqual([]);
    expect(validate({ ...ok, heard: 'x'.repeat(81) })).toEqual(['heard']);
  });
});

describe('finding 9: client email check = server normalizeAddEmail', () => {
  const d189 = `${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`;
  const cases = [
    'a@b.co',
    'Dana.Levi+x@Example.COM',
    '  dana@example.com  ',
    'dana_%-x@sub.example.co.il',
    'דנה@example.com',
    'dana@exämple.com',
    'dana@example.קום',
    'testK@example.com', // KELVIN SIGN lower-cases to "k"
    'Kelvin@example.com',
    'dana@example.com ',
    'a b@example.com',
    'a@b',
    'a@b.c',
    'a..b@example.com',
    '.a@example.com',
    'a.@example.com',
    'a@-b.com',
    'a@b-.com',
    'a@b..com',
    'a@@b.com',
    '',
    `${'a'.repeat(64)}@example.com`,
    `${'a'.repeat(65)}@example.com`,
    `${'a'.repeat(64)}@${d189}`, // 254
    `${'a'.repeat(64)}@${d189.replace('d'.repeat(57), 'd'.repeat(58))}`, // 255
    `${' '.repeat(70)}a@b.co${' '.repeat(250)}`, // 326 before trim (server caps raw length at 320)
    'a@b.co\u0000',
    "o'brien@example.com",
  ];
  it('lengths of the long cases are what the names say', () => {
    expect(cases[23].length).toBe(254);
    expect(cases[24].length).toBe(255);
  });
  it.each(cases.map((c) => [JSON.stringify(c), c]))('%s', (_n, c) => {
    expect(normalizeEmail(c)).toBe(normalizeAddEmail(c));
    const fields = { name: 'N', email: c, role: 'R', lang: 'en', consent: true };
    const server = validateSignup(fields, { heardFrom: true });
    const client = validate({ name: 'N', email: c, role: 'R', age: true, consent: true });
    expect(client.includes('email'), c).toBe(!server.ok);
  });
  it('non-string values are refused by both', () => {
    for (const v of [undefined, null, 5, {}, ['a@b.co']])
      expect(normalizeEmail(v)).toBe(normalizeAddEmail(v));
  });
});

describe('findings 16a-c, 17: Hebrew page details', () => {
  it.each(['he', 'en'])('%s 16a: one no-JS message (no duplicate <noscript>)', (l) => {
    const h = page(preview, l);
    expect(h).not.toContain('<noscript>');
    expect(h.match(/id="su-nojs"/g)).toHaveLength(1);
    expect(content[l].signup.noscript).toBeUndefined();
  });
  it.each(['he', 'en'])(
    '%s 16b: no hidden h2 repeating the h1; the form is named by the h1',
    (l) => {
      const h = page(preview, l);
      expect(h).not.toContain('id="su-form-h"');
      expect(h).toMatch(/<h1 id="su-h1">/);
      expect(h).toMatch(/<form id="signup-form"[^>]*aria-labelledby="su-h1"/);
    },
  );
  it.each(['he', 'en'])('%s 16c: the name field takes its direction from what is typed', (l) => {
    expect(page(preview, l).match(/<input[^>]*id="su-name"[^>]*>/)[0]).toContain('dir="auto"');
  });
  it('17: Hebrew form addresses the reader in plural (except the label kept as in the existing form)', () => {
    const s = content.he.signup;
    expect(s.role).toBe('מה מתאר אתכם הכי טוב?');
    const all = JSON.stringify({ ...s, heard: '' });
    for (const singular of ['אותך', 'שמעת ', 'שמעת?', 'הגעת']) expect(all).not.toContain(singular);
  });
});

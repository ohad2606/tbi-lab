import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSite, pagePath } from '../build.mjs';
import { content, LANGS, PAGES, CONTACT_EMAIL, LAB_URL, APPLY_URL } from '../content.mjs';

let out;
const read = (rel) => readFileSync(join(out, rel), 'utf8');
const html = (lang, page) => read(pagePath(lang, page).slice(1) + 'index.html');
function walk(dir, acc = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}
function keys(v, prefix = '') {
  if (Array.isArray(v))
    return [`${prefix}[${v.length}]`, ...v.flatMap((x, i) => keys(x, `${prefix}[${i}]`))];
  if (v && typeof v === 'object')
    return Object.keys(v).flatMap((k) => keys(v[k], prefix ? `${prefix}.${k}` : k));
  return [prefix];
}
const NOT_PER_LANG = new Set(['lang', 'dir', 'langName', 'switchTo', 'switchToLang']);

beforeAll(() => {
  out = buildSite(mkdtempSync(join(tmpdir(), 'tbi-site-')));
});

describe('content', () => {
  it('he and en have exactly the same keys and list lengths', () => {
    expect(keys(content.he).sort()).toEqual(keys(content.en).sort());
  });
  it('no empty strings', () => {
    for (const l of LANGS) for (const k of keys(content[l])) expect(k).not.toBe('');
    const check = (v) =>
      Array.isArray(v)
        ? v.forEach(check)
        : v && typeof v === 'object'
          ? Object.values(v).forEach(check)
          : expect(String(v).trim().length).toBeGreaterThan(0);
    check(content.he);
    check(content.en);
  });
  it('declares direction per language', () => {
    expect([content.he.lang, content.he.dir]).toEqual(['he', 'rtl']);
    expect([content.en.lang, content.en.dir]).toEqual(['en', 'ltr']);
    expect(NOT_PER_LANG.size).toBeGreaterThan(0);
  });
});

describe('build output', () => {
  it('builds root and every page in both languages', () => {
    expect(existsSync(join(out, 'index.html'))).toBe(true);
    for (const l of LANGS)
      for (const p of PAGES)
        expect(existsSync(join(out, pagePath(l, p).slice(1), 'index.html'))).toBe(true);
  });
  it('root is a static link pair with no script or meta refresh', () => {
    const r = read('index.html');
    expect(r).toContain('href="/he/"');
    expect(r).toContain('href="/en/"');
    expect(r).not.toMatch(/<script|http-equiv/i);
  });
  it.each(LANGS.flatMap((l) => PAGES.map((p) => [l, p])))('%s/%s structure', (lang, page) => {
    const h = html(lang, page);
    const c = content[lang];
    expect(h).toContain(`<html lang="${c.lang}" dir="${c.dir}">`);
    expect(h.match(/<h1[ >]/g)).toHaveLength(1);
    for (const tag of ['header', 'nav', 'main', 'footer']) expect(h).toContain(`<${tag}`);
    expect(h).toContain('class="skip" href="#main"');
    expect(h).toMatch(/<meta name="description" content="[^"]+"/);
    expect(h).toContain('rel="alternate" hreflang="he"');
    expect(h).toContain('rel="alternate" hreflang="en"');
    const other = c.switchToLang;
    expect(h).toContain(`hreflang="${other}" lang="${other}"`);
    expect(h).not.toMatch(/\[\[|\]\]/);
  });
  it('titles are unique per language', () => {
    for (const l of LANGS) {
      const titles = PAGES.map((p) => html(l, p).match(/<title>([^<]+)<\/title>/)[1]);
      expect(new Set(titles).size).toBe(PAGES.length);
    }
  });
  it('heading order never skips a level', () => {
    for (const l of LANGS)
      for (const p of PAGES) {
        let prev = 0;
        for (const m of html(l, p).matchAll(/<h([1-6])[ >]/g)) {
          expect(Number(m[1])).toBeLessThanOrEqual(prev + 1);
          prev = Number(m[1]);
        }
      }
  });
  it('technical tokens are LTR isolates', () => {
    expect(html('he', 'product')).toContain('<span dir="ltr">ESP32</span>');
    expect(html('he', 'product')).toContain('<span dir="ltr">GPIO2</span>');
  });
  it('internal links and fragments resolve', () => {
    for (const f of walk(out).filter((x) => x.endsWith('.html'))) {
      const h = readFileSync(f, 'utf8');
      for (const m of h.matchAll(/(?:href|src)="([^"]+)"/g)) {
        const url = m[1];
        if (
          url === LAB_URL ||
          url === 'mailto:' + CONTACT_EMAIL ||
          (APPLY_URL && url === APPLY_URL)
        )
          continue;
        expect(url).not.toMatch(/^[a-z]+:|^\/\//i);
        const [path, frag] = url.split('#');
        let target = f;
        if (path) {
          const rel = path.replace(/^\//, '');
          target = join(out, rel.endsWith('/') || rel === '' ? join(rel, 'index.html') : rel);
          expect(existsSync(target), `${f} -> ${url}`).toBe(true);
        }
        if (frag) expect(readFileSync(target, 'utf8'), `${f} -> ${url}`).toContain(`id="${frag}"`);
      }
    }
  });
  it('has no scripts, inline styles/handlers, third-party URLs, other emails or phone numbers', () => {
    for (const f of walk(out).filter((x) => /\.(html|css)$/.test(x))) {
      const t = readFileSync(f, 'utf8');
      expect(t, f).not.toMatch(/<script|\sstyle=|\son[a-z]+=|<style/i);
      // the only absolute URLs allowed are the tester sign-in link and the configured sign-up form
      let noLab = t.replaceAll(`href="${LAB_URL}"`, '');
      if (APPLY_URL) noLab = noLab.replaceAll(`href="${APPLY_URL}"`, '');
      // link-preview (Open Graph) tags must be absolute and point only at this site
      noLab = noLab.replace(
        /<meta property="og:(?:url|image|image:secure_url)" content="https:\/\/join-lab\.tbi-tech\.net\/[^"]*">/g,
        '',
      );
      expect(noLab, f).not.toMatch(/https?:\/\/|@import|\/\/[a-z0-9.-]+\.[a-z]/i);
      // url() only for the self-hosted fonts, and every one must exist in the build
      for (const [, u] of t.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) {
        expect(u, f).toMatch(/^\/assets\/fonts\/[a-z0-9.-]+\.woff2$/);
        expect(existsSync(join(out, u)), f + ' -> ' + u).toBe(true);
      }
      if (f.endsWith('.html')) {
        // exactly one email address is allowed
        const emails = t.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g) ?? [];
        for (const e of emails) expect(e, f).toBe(CONTACT_EMAIL);
        expect(t.replaceAll(CONTACT_EMAIL, '')).not.toContain('@');
        expect(t, f).not.toMatch(/mailto:(?!support@tbi-tech\.net")/);
      }
      expect(t, f).not.toMatch(/\b\d{2,3}[-\s]?\d{3}[-\s]?\d{4}\b/);
    }
  });
  it('contact address is support@tbi-tech.net, linked in footer and legal pages', () => {
    expect(CONTACT_EMAIL).toBe('support@tbi-tech.net');
    for (const l of LANGS)
      for (const p of PAGES)
        expect(html(l, p), `${l}/${p}`).toContain('href="mailto:support@tbi-tech.net"');
  });
  it('no unfinished placeholders, no Terms page, footer brand is TBI', () => {
    for (const l of LANGS) {
      expect(existsSync(join(out, l, 'terms'))).toBe(false);
      for (const p of PAGES) {
        const h = html(l, p);
        expect(h, `${l}/${p}`).not.toMatch(/TBD|to be added|COMPANY LEGAL|Draft —|טיוטה —/i);
        expect(h).not.toMatch(/href="[^"]*terms/);
        expect(h).toContain('<p class="copy"><small>TBI</small></p>');
      }
    }
  });
  it('no hype "real" claims', () => {
    for (const l of ['he', 'en'])
      for (const pg of Object.values(content[l].pages))
        expect(JSON.stringify(pg)).not.toMatch(/\breal\b|אמית/i);
  });

  it('forbidden claims are absent', () => {
    for (const l of LANGS)
      for (const p of PAGES) {
        const text = html(l, p);
        expect(text, `${l}/${p}`).not.toMatch(/firefox|wi-?fi|phone|tablet|טלפון|טאבלט|פיירפוקס/i);
      }
  });
  it('tester sign-in links to the Lab, labelled for approved testers', () => {
    expect(LAB_URL).toBe('https://lab.tbi-tech.net/');
    for (const l of LANGS)
      for (const p of PAGES.filter((x) => x !== 'home' || true)) {
        const h = html(l, p);
        expect(h).toContain(`href="${LAB_URL}" rel="noopener">${content[l].signIn}`);
        expect(h).toContain(content[l].signInHint);
      }
  });
  it('privacy is marked interim and says what the site collects', () => {
    expect(html('en', 'privacy')).toContain('Interim text');
    expect(html('he', 'privacy')).toContain('טקסט ביניים');
    const en = html('en', 'privacy');
    for (const s of ['no cookies', 'no analytics', 'Google Forms', '90 days', '12 months'])
      expect(
        en.replace(/sets no cookies/, 'no cookies').replace(/uses no analytics/, 'no analytics'),
      ).toContain(s);
  });
  it('accessibility statement is honest: no conformance claim, not screen-reader tested', () => {
    const a = html('en', 'accessibility');
    expect(a).toContain('has not yet been tested with screen readers');
    expect(a).toContain('do not claim conformance');
    expect(a).not.toMatch(/WCAG|compl(?:ies|iant) with|accessible to all/i);
  });
  it('home has hero, six feature cards and screenshots as figures', () => {
    for (const l of LANGS) {
      const h = html(l, 'home');
      expect(h).toContain('class="hero"');
      expect(h.match(/class="card"/g)).toHaveLength(6);
      expect(h).toContain('id="screenshots"');
      const imgs = [...h.matchAll(/<img[^>]+src="\/assets\/images\/[^"]+"[^>]*>/g)].map(
        (m) => m[0],
      );
      expect(imgs.length).toBeGreaterThanOrEqual(2);
      for (const i of imgs) {
        expect(i).toMatch(/width="\d+" height="\d+"/);
        expect(i).toContain('loading="lazy"');
        expect(i).toMatch(/alt="[^"]{20,}"/);
      }
      expect(h.match(/<figcaption>/g)).toHaveLength(imgs.length);
    }
  });
  it('screenshots are copied to dist, each <= 600 KB, with HE+EN alt and caption', async () => {
    const { SCREENSHOTS } = await import('../content.mjs');
    for (const i of SCREENSHOTS) {
      const f = join(out, i.src.slice(1));
      expect(existsSync(f)).toBe(true);
      expect(statSync(f).size).toBeLessThanOrEqual(600 * 1024);
      for (const l of LANGS) {
        expect(i.alt[l].length).toBeGreaterThan(20);
        expect(i.caption[l].length).toBeGreaterThan(5);
      }
    }
  });
  it('CTA: pending state when APPLY_URL is empty, https link when set (both modes)', () => {
    // the configured form (owner-supplied Google Form) is https and is what the default build links to
    expect(APPLY_URL === '' || /^https:\/\/forms\.gle\/[A-Za-z0-9]+$/.test(APPLY_URL)).toBe(true);
    if (APPLY_URL)
      for (const l of LANGS)
        expect(html(l, 'home')).toContain(`href="${APPLY_URL}" rel="noopener"`);
    const out0 = buildSite(mkdtempSync(join(tmpdir(), 'tbi-site-pending-')), { applyUrl: '' });
    const h = readFileSync(join(out0, 'en', 'index.html'), 'utf8');
    expect(h).toContain('class="btn btn-pending" href="/en/alpha/#how-to-apply"');
    expect(h).not.toContain('btn-primary');
    expect(h).toContain('Registration opens soon');
    const url = 'https://forms.example.org/join';
    const out2 = buildSite(mkdtempSync(join(tmpdir(), 'tbi-site-apply-')), { applyUrl: url });
    for (const l of LANGS) {
      const o = readFileSync(join(out2, l, 'index.html'), 'utf8');
      expect(o).toContain(`class="btn btn-primary" href="${url}" rel="noopener"`);
      expect(o).not.toContain('btn-pending');
      const al = readFileSync(join(out2, l, 'alpha', 'index.html'), 'utf8');
      expect(al).toContain(`href="${url}" rel="noopener"`);
    }
    for (const bad of [
      'http://x.example/f',
      'javascript:alert(1)',
      '//x.example',
      'https://x.example/"onclick=',
    ]) {
      expect(() =>
        buildSite(mkdtempSync(join(tmpdir(), 'tbi-site-bad-')), { applyUrl: bad }),
      ).toThrow();
    }
  });
  it('stylesheet uses logical properties only', () => {
    const css = read('assets/site.css');
    expect(css).not.toMatch(
      /(?:^|[;{\s])(margin|padding|border)-(left|right)|(?:^|[;{\s])(left|right|float)\s*:|text-align:\s*(left|right)/,
    );
  });
  it('alpha page carries the required messaging and apply links to it', () => {
    const a = html('en', 'alpha');
    for (const s of [
      'Applying does not give access',
      'reviewed manually',
      'waiting list',
      'Only approved accounts can sign in',
      'Free of charge',
      'No SLA',
      'Data may be reset',
    ])
      expect(a).toContain(s);
    if (APPLY_URL) {
      for (const l of LANGS)
        expect(html(l, 'alpha')).toContain(`href="${APPLY_URL}" rel="noopener"`);
    } else {
      expect(html('en', 'home')).toContain('href="/en/alpha/#how-to-apply"');
      expect(html('he', 'home')).toContain('href="/he/alpha/#how-to-apply"');
    }
    expect(html('en', 'home')).toContain('Electronics Engineering Workspace');
  });
  it('every page has an Open Graph card with the TBI Lab preview image', () => {
    const img = 'https://join-lab.tbi-tech.net/assets/og/tbi-lab-preview.png';
    expect(existsSync(join(out, 'assets', 'og', 'tbi-lab-preview.png'))).toBe(true);
    for (const f of walk(out).filter((x) => x.endsWith('.html'))) {
      const t = readFileSync(f, 'utf8');
      expect(t, f).toContain(`<meta property="og:image" content="${img}">`);
      expect(t, f).toMatch(/<meta property="og:title" content="[^"]+">/);
      expect(t, f).toMatch(
        /<meta property="og:url" content="https:\/\/join-lab\.tbi-tech\.net\/[^"]*">/,
      );
    }
  });
  it('copies brand assets', () => {
    for (const f of ['tbi-lab-logo.png', 'favicon.ico', 'site.css'])
      expect(existsSync(join(out, 'assets', f))).toBe(true);
  });
});

describe('HE titles are Hebrew', () => {
  it('no HE page title or home meta is pure ASCII', () => {
    for (const page of PAGES) {
      const h = html('he', page);
      const title = h.match(/<title>([^<]*)<\/title>/)[1];
      expect(title, `${page} title`).toMatch(/[֐-׿]/);
      const desc = h.match(/<meta name="description" content="([^"]*)"/)[1];
      expect(desc, `${page} description`).toMatch(/[֐-׿]/);
    }
  });
});

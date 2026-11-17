import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSite, pagePath } from '../build.mjs';
import { content, LANGS, PAGES } from '../content.mjs';

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
  it('has no scripts, inline styles/handlers, external URLs, emails or contact data', () => {
    for (const f of walk(out).filter((x) => /\.(html|css)$/.test(x))) {
      const t = readFileSync(f, 'utf8');
      expect(t, f).not.toMatch(/<script|\sstyle=|\son[a-z]+=|<style/i);
      expect(t, f).not.toMatch(/https?:\/\/|@import|url\(/i);
      if (f.endsWith('.html')) expect(t, f).not.toContain('@');
      expect(t, f).not.toMatch(/\b\d{2,3}[-\s]?\d{3}[-\s]?\d{4}\b/);
    }
  });
  it('stylesheet uses logical properties only', () => {
    const css = read('assets/site.css');
    expect(css).not.toMatch(
      /(?:^|[;{\s])(margin|padding|border)-(left|right)|(?:^|[;{\s])(left|right|float)\s*:|text-align:\s*(left|right)/,
    );
  });
  it('legal pages are placeholders only', () => {
    for (const l of LANGS)
      for (const p of ['privacy', 'terms', 'accessibility']) {
        const h = html(l, p);
        expect(h).toContain(content[l].draftNote);
        expect(h).toContain('[COMPANY LEGAL NAME TBD]');
      }
    expect(html('en', 'home')).not.toContain('COMPANY LEGAL NAME');
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
    expect(html('en', 'home')).toContain('href="/en/alpha/#how-to-apply"');
    expect(html('he', 'home')).toContain('href="/he/alpha/#how-to-apply"');
    expect(html('en', 'home')).toContain('Electronics Engineering Workspace');
  });
  it('copies brand assets', () => {
    for (const f of ['tbi-lab-logo.png', 'favicon.ico', 'site.css'])
      expect(existsSync(join(out, 'assets', f))).toBe(true);
  });
});

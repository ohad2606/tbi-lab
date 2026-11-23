import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSite } from '../build.mjs';
import { content } from '../content.mjs';

// sha256 over (relative path, bytes) of the whole flag=false build, taken before BETA-G1 s11 (3249181).
// If you change the flag=false site on purpose, update this value in the same commit.
const FLAG_FALSE_HASH = '91f51086897fe627340180f6d56450445a4c3393ce7e8974f096995486586122';

const walk = (d) =>
  readdirSync(d)
    .sort()
    .flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
const treeHash = (root) => {
  const h = createHash('sha256');
  for (const f of walk(root))
    h.update(f.slice(root.length) + '\0')
      .update(readFileSync(f))
      .update('\0');
  return h.digest('hex');
};

let off;
let on;
const html = (o, l, p = '') => readFileSync(join(o, l, p, 'index.html'), 'utf8');
beforeAll(() => {
  off = buildSite(mkdtempSync(join(tmpdir(), 'tbi-flip-off-')));
  on = buildSite(mkdtempSync(join(tmpdir(), 'tbi-flip-on-')), { signupEnabled: true });
});

describe('site flip mode: flag=false', () => {
  it('build output is byte-identical to the pre-s11 snapshot', () => {
    expect(treeHash(off)).toBe(FLAG_FALSE_HASH);
  });
  it('still says Google Forms and uses the Google link', () => {
    expect(html(off, 'en', 'alpha')).toContain('Google Forms');
    expect(html(off, 'he', 'alpha')).toContain('Google Forms');
    expect(html(off, 'en', 'privacy')).toContain('Google Forms');
    expect(html(off, 'en')).toContain('forms.gle');
  });
});

describe('site flip mode: flag=true', () => {
  it.each(['he', 'en'])('%s: apply CTAs on home and alpha point to the own page', (l) => {
    for (const p of ['', 'alpha']) {
      const h = html(on, l, p);
      expect(h).toContain(`class="btn btn-primary" href="/${l}/signup/"`);
      expect(h).not.toContain('btn-pending');
    }
  });
  it.each(['he', 'en'])('%s: alpha shows the own-form text, not pending or Google', (l) => {
    const h = html(on, l, 'alpha');
    const a = content[l].pages.alpha.sections.find((s) => s.id === 'how-to-apply');
    expect(h).toContain(a.pOpenOwn[0]);
    expect(h).not.toContain(a.pPending[0]);
    expect(h).not.toContain(a.pOpen[0]);
  });
  it('no Google Forms / forms.gle anywhere in the built HTML', () => {
    for (const f of walk(on).filter((x) => x.endsWith('.html'))) {
      const t = readFileSync(f, 'utf8');
      expect(t, f).not.toMatch(/forms\.gle|Google Forms|docs\.google/i);
    }
  });
  it('privacy: own-form wording, providers LTR, no cookies', () => {
    const en = html(on, 'en', 'privacy');
    for (const s of ['Telegram', 'Resend', 'no cookies', '90 days', '12 months', 'Interim text'])
      expect(en).toContain(s);
    const he = html(on, 'he', 'privacy');
    expect(he).toContain('טקסט ביניים');
    expect(he).toContain('אין עוגיות');
    expect(he).toMatch(/<bdi[^>]*>Telegram<\/bdi>|dir="ltr"[^>]*>Telegram</);
    expect(he).toMatch(/<bdi[^>]*>Resend<\/bdi>|dir="ltr"[^>]*>Resend</);
    expect(he).not.toContain('גוגל');
  });
  it('HE and EN have the same flip keys', () => {
    for (const l of ['he', 'en']) {
      const s = content[l].pages.privacy.sections.find((x) => x.id === 'signup');
      expect(s.pOwn).toHaveLength(4);
      expect(s.p).toHaveLength(2);
    }
  });
});

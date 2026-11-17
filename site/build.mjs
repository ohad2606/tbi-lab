#!/usr/bin/env node
/**
 * Static generator for the public site (TBI-013). No dependencies, no client JS.
 * Usage: node site/build.mjs [outDir]   (default site/dist). Exported: buildSite(outDir).
 */
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { content, LANGS, DEFAULT_LANG, PAGES, NAV_PAGES, FOOTER_PAGES } from './content.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const BRAND_DIR = join(here, '..', 'app', 'src', 'assets', 'brand');

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
/** Escape, then turn [[TOKEN]] into an LTR isolate. */
const rich = (s) => esc(s).replace(/\[\[([^\]]+)\]\]/g, '<span dir="ltr">$1</span>');
const plain = (s) => String(s).replace(/\[\[([^\]]+)\]\]/g, '$1');

export const pagePath = (lang, page) => (page === 'home' ? `/${lang}/` : `/${lang}/${page}/`);

function renderSection(s) {
  const p = (s.p ?? []).map((t) => `<p>${rich(t)}</p>`).join('\n');
  const ul = s.ul ? `<ul>\n${s.ul.map((t) => `<li>${rich(t)}</li>`).join('\n')}\n</ul>` : '';
  return `<section>\n<h2 id="${s.id}" tabindex="-1">${rich(s.h)}</h2>\n${p}\n${ul}\n</section>`;
}

function renderPage(lang, page) {
  const t = content[lang];
  const other = content[t.switchToLang];
  const pg = t.pages[page];
  const nav = NAV_PAGES.map((n) => {
    const cur = n === page ? ' aria-current="page"' : '';
    return `<li><a href="${pagePath(lang, n)}"${cur}>${esc(t.navNames[n])}</a></li>`;
  }).join('\n');
  const foot = FOOTER_PAGES.map((n) => {
    const cur = n === page ? ' aria-current="page"' : '';
    return `<li><a href="${pagePath(lang, n)}"${cur}>${esc(t.footerNames[n])}</a></li>`;
  }).join('\n');
  const alts = LANGS.map(
    (l) => `<link rel="alternate" hreflang="${l}" href="${pagePath(l, page)}">`,
  ).join('\n');

  let body;
  if (page === 'home') {
    body = `<div class="hero">
<img class="logo" src="/assets/tbi-lab-logo.png" width="260" height="150" alt="${esc(t.logoAlt)}">
<h1>${esc(pg.h1)}</h1>
<p class="descriptor" lang="${t.descriptorLang}" dir="ltr">${esc(pg.lead)}</p>
<p class="note">${rich(t.desktopNote)}</p>
<p><a class="btn btn-pending" href="${pagePath(lang, 'alpha')}#how-to-apply" aria-describedby="apply-hint">${esc(t.applyPending)}</a></p>
<p class="note" id="apply-hint">${esc(t.applyHint)}</p>
</div>
${pg.sections.map(renderSection).join('\n')}`;
  } else if (FOOTER_PAGES.includes(page)) {
    body = `<h1>${esc(pg.h1)}</h1>
<p class="draft">${esc(t.draftNote)}</p>
<p>${esc(t.companyLine)}</p>
<p>${esc(t.contactLabel)}: ${esc(t.contact)}</p>`;
  } else {
    body = `<h1>${esc(pg.h1)}</h1>
${pg.lead ? `<p class="lead">${rich(pg.lead)}</p>` : ''}
${pg.sections.map(renderSection).join('\n')}
${page === 'alpha' ? `<p><a class="btn btn-pending" href="#how-to-apply">${esc(t.applyPending)}</a></p>` : ''}`;
  }

  return `<!doctype html>
<html lang="${t.lang}" dir="${t.dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(plain(pg.title))}</title>
<meta name="description" content="${esc(plain(pg.description))}">
${alts}
<link rel="icon" href="/assets/favicon.ico" sizes="any">
<link rel="icon" type="image/png" href="/assets/favicon-32.png" sizes="32x32">
<link rel="stylesheet" href="/assets/site.css">
</head>
<body>
<a class="skip" href="#main">${esc(t.skip)}</a>
<header>
<p class="brand"><a href="${pagePath(lang, 'home')}">${esc(t.siteName)}</a></p>
<nav aria-label="${esc(t.navLabel)}">
<ul>
${nav}
<li><a href="${pagePath(t.switchToLang, page)}" hreflang="${t.switchToLang}" lang="${other.lang}">${esc(t.switchTo)}</a></li>
</ul>
</nav>
</header>
<main id="main" tabindex="-1">
${body}
</main>
<footer>
<nav aria-label="${esc(t.footerLabel)}">
<ul>
${foot}
</ul>
</nav>
<p>${esc(t.contactLabel)}: ${esc(t.contact)}</p>
<p><small>${esc(t.brand)}</small></p>
</footer>
</body>
</html>
`;
}

function renderRoot() {
  const links = LANGS.map((l) => {
    const c = content[l];
    return `<li><a href="${pagePath(l, 'home')}" hreflang="${l}" lang="${l}">${esc(c.langName)}</a></li>`;
  }).join('\n');
  const alts = LANGS.map(
    (l) => `<link rel="alternate" hreflang="${l}" href="${pagePath(l, 'home')}">`,
  ).join('\n');
  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TBI Lab — עברית / English</title>
<meta name="description" content="TBI Lab — Electronics Engineering Workspace. Choose a language.">
${alts}
<link rel="alternate" hreflang="x-default" href="/">
<link rel="icon" href="/assets/favicon.ico" sizes="any">
<link rel="stylesheet" href="/assets/site.css">
</head>
<body>
<a class="skip" href="#main">Skip to main content</a>
<main id="main" tabindex="-1" class="root">
<h1>TBI Lab</h1>
<p>Electronics Engineering Workspace</p>
<nav aria-label="Language">
<ul class="langs">
${links}
</ul>
</nav>
</main>
</body>
</html>
`;
}

export function buildSite(outDir = join(here, 'dist')) {
  const out = resolve(outDir);
  rmSync(out, { recursive: true, force: true });
  const write = (rel, data) => {
    const f = join(out, rel);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, data);
  };
  write('index.html', renderRoot());
  for (const lang of LANGS)
    for (const page of PAGES)
      write(`${lang}${pagePath(lang, page).slice(3)}index.html`, renderPage(lang, page));
  mkdirSync(join(out, 'assets'), { recursive: true });
  copyFileSync(join(here, 'site.css'), join(out, 'assets', 'site.css'));
  copyFileSync(join(BRAND_DIR, 'tbi-lab-logo.png'), join(out, 'assets', 'tbi-lab-logo.png'));
  for (const f of ['favicon.ico', 'favicon-32.png'])
    copyFileSync(join(BRAND_DIR, 'icons', 'production', f), join(out, 'assets', f));
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = buildSite(process.argv[2]);
  console.log(`site built: ${out} (default language ${DEFAULT_LANG})`);
}

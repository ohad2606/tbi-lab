#!/usr/bin/env node
/**
 * Static generator for the public site (TBI-013). No dependencies, no client JS.
 * Usage: node site/build.mjs [outDir] [--signup-preview] [--signup-verify]   (default site/dist).
 * Exported: buildSite(outDir, opts).
 * --signup-preview: e2e / local preview only (builds the unlinked sign-up page while the flag is off).
 */
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  content,
  LANGS,
  DEFAULT_LANG,
  PAGES,
  NAV_PAGES,
  FOOTER_PAGES,
  LEGAL_PAGES,
  APPLY_URL,
  LAB_URL,
  CONTACT_EMAIL,
  SCREENSHOTS,
  SIGNUP_PAGE_ENABLED,
  SIGNUP_VERIFY_ENABLED,
  SIGNUP_NOINDEX,
  SIGNUP_API_BASE,
  SIGNUP_ROLE_VALUES,
} from './content.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const BRAND_DIR = join(here, '..', 'app', 'src', 'assets', 'brand');

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
/** Escape, then turn [[TOKEN]] into an LTR isolate. */
const rich = (s, lang = 'en') =>
  esc(s).replace(/\[\[([^\]]+)\]\]/g, (_, tok) =>
    lang === 'he' && /^[\x20-\x7E]*[A-Za-z][\x20-\x7E]*$/.test(tok)
      ? `<span dir="ltr" lang="en">${tok}</span>`
      : `<span dir="ltr">${tok}</span>`,
  );
const plain = (s) => String(s).replace(/\[\[([^\]]+)\]\]/g, '$1');

export const pagePath = (lang, page) => (page === 'home' ? `/${lang}/` : `/${lang}/${page}/`);

const mail = `<a href="mailto:${CONTACT_EMAIL}"><span dir="ltr">${CONTACT_EMAIL}</span></a>`;
/** rich text plus the public contact address turned into a mailto link. */
const rich2 = (s, lang) => rich(s, lang).replaceAll(CONTACT_EMAIL, mail);

function checkApplyUrl(u) {
  if (u !== '' && !/^https:\/\/[^\s"'<>]+$/.test(u))
    throw new Error('APPLY_URL must be empty or an https URL');
  return u;
}

function renderSection(s, level = 2, lang = 'en') {
  const paras = (list) => (list ?? []).map((t) => `<p>${rich2(t, lang)}</p>`).join('\n');
  const p = paras(s.p);
  // `pEnd`: paragraphs after the list.
  const end = s.pEnd ? `${paras(s.pEnd)}\n` : '';
  const ul = s.ul ? `<ul>\n${s.ul.map((t) => `<li>${rich2(t, lang)}</li>`).join('\n')}\n</ul>` : '';
  return `<section>\n<h${level} id="${s.id}" tabindex="-1">${rich(s.h, lang)}</h${level}>\n${p}\n${ul}\n${end}</section>`;
}

/** The `signupVerify` copy of a page's sections; `patch` is content[lang].signupVerify.pages[page] (see content.mjs). */
function verifySections(sections, patch = {}) {
  return sections.flatMap((s) => {
    const change = patch[s.id];
    if (change === false) return [];
    const { next = [], ...own } = change ?? {};
    return [{ ...s, ...own }, ...next];
  });
}

/** Public origin of the landing site; used only for link-preview (Open Graph) tags, which must be absolute. */
export const SITE_ORIGIN = 'https://join-lab.tbi-tech.net';
const OG_IMAGE = '/assets/og/tbi-lab-preview.png';

/** Open Graph tags so WhatsApp, Facebook and others show the TBI Lab logo card for a shared link. */
function ogTags({ url, title, description, locale, altLocale }) {
  const img = SITE_ORIGIN + OG_IMAGE;
  return [
    ['og:type', 'website'],
    ['og:site_name', 'TBI Lab'],
    ['og:title', title],
    ['og:description', description],
    ['og:url', SITE_ORIGIN + url],
    ['og:image', img],
    ['og:image:secure_url', img],
    ['og:image:type', 'image/png'],
    ['og:image:width', '1200'],
    ['og:image:height', '630'],
    ['og:image:alt', 'TBI Lab: Think, Bring ideas to life, Invent'],
    ['og:locale', locale],
    ...(altLocale ? [['og:locale:alternate', altLocale]] : []),
  ]
    .map(([k, v]) => `<meta property="${k}" content="${esc(v)}">`)
    .join('\n');
}
const OG_LOCALE = { he: 'he_IL', en: 'en_US' };

/**
 * G1-AUTO-VERIFY slice 3: the confirm view (`#verify=<token>`) and the resend form, hidden until the client script
 * (site/signup-verify.mjs) shows them. Every sentence is rendered here; the script copies text and toggles. The resend
 * form has no `action` and no `data-api`: the publish gate allows only the sign-up form's.
 */
function renderVerifyView(lang, f, v) {
  const results = ['Received', 'Expired', 'Invalid', 'Rate', 'Network', 'Unavailable', 'Sent'];
  const texts = [
    ['confirmTitle', esc(v.confirmTitle)],
    ['confirmH', esc(v.confirmH)],
    ...results.flatMap((r) => [
      [`result${r}H`, esc(v[`result${r}H`])],
      [`result${r}P`, rich2(v[`result${r}P`], lang)],
    ]),
    ['resultFailH', esc(v.resultFailH)],
    ['confirmSending', esc(v.confirmSending)],
    ['resendSending', esc(v.resendSending)],
    ['resendUnavailable', esc(v.resendUnavailable)],
    ['resendInvalid', esc(v.resendInvalid)],
    ['resendNetwork', esc(v.resendNetwork)],
  ]
    .map(([k, html]) => `<span data-vf="${k}">${html}</span>`)
    .join('\n');
  return `<div hidden>
${texts}
</div>
<div id="vf" hidden>
<p id="vf-intro">${esc(v.confirmP)}</p>
<p id="vf-sending" class="hint-text" aria-hidden="true" hidden></p>
<div id="vf-progress" class="visually-hidden" role="status" aria-live="polite" aria-atomic="true"></div>
<div id="vf-result" role="group" aria-labelledby="vf-result-h" aria-describedby="vf-result-p" tabindex="-1" hidden>
<h2 id="vf-result-h"></h2>
<p id="vf-result-p"></p>
</div>
<p id="vf-confirm"><button type="button" class="btn btn-primary" id="vf-button" aria-disabled="false">${esc(v.confirmButton)}</button></p>
<form id="vf-resend" method="post" novalidate hidden aria-labelledby="vf-resend-h">
<h2 id="vf-resend-h" class="small-h">${esc(v.resendH)}</h2>
<div class="field">
<label for="vf-email">${rich(f.email, lang)}</label>
<p class="hint-text" id="vf-hint-email">${rich(f.emailHint, lang)}</p>
<input type="email" id="vf-email" name="email" autocomplete="email" inputmode="email" dir="ltr" maxlength="254" spellcheck="false" autocapitalize="off" aria-required="true" aria-describedby="vf-hint-email">
<p class="field-error" id="vf-err-email" hidden>${esc(f.errEmail)}</p>
</div>
<div class="hp" aria-hidden="true" inert>
<label for="vf-website">${esc(f.honeypot)}</label>
<input type="text" id="vf-website" name="website" value="" tabindex="-1" autocomplete="off" aria-hidden="true" data-lpignore="true" data-1p-ignore="true">
</div>
<p><button type="submit" class="btn btn-primary" id="vf-resend-button" aria-disabled="false">${esc(v.resendButton)}</button></p>
<p id="vf-resend-sending" class="hint-text" aria-hidden="true" hidden></p>
</form>
</div>`;
}

/** Sign-up form body (BETA-G1 s9). All text comes from content.mjs; the client script only toggles it. */
function renderSignupBody(lang, t, page, verify) {
  // signupVerify (off by default): the changed copy replaces the base strings, and the confirm view is added.
  const v = verify ? t.signupVerify : null;
  const pg = v ? { ...page, lead: v.lead } : page;
  const f = v
    ? {
        ...t.signup,
        email: v.email,
        emailHint: v.emailHint,
        successH: v.successH,
        successP: v.successP,
      }
    : t.signup;
  const privacyHref = pagePath(lang, 'privacy');
  const errKey = (key) => 'err' + key[0].toUpperCase() + key.slice(1);
  const errP = (key) =>
    `<p class="field-error" id="su-err-${key}" hidden>${esc(f[errKey(key)])}</p>`;
  const field = (key, label, control, hint = '', labelExtra = '') =>
    `<div class="field">
<label for="su-${key}">${rich(label, lang)}${labelExtra}</label>
${hint ? `<p class="hint-text" id="su-hint-${key}">${rich(hint, lang)}</p>` : ''}
${control}
${errP(key)}
</div>`;
  const opts = (values, labels, pick) =>
    `<option value="">${esc(pick)}</option>\n` +
    values.map((v, i) => `<option value="${esc(v)}">${esc(labels[i])}</option>`).join('\n');
  const check = (key, inner) =>
    `<div class="field check">
<input type="checkbox" id="su-${key}" name="${key}" aria-required="true">
<label for="su-${key}">${inner}</label>
${errP(key)}
</div>`;
  const msgKeys = [
    'msgInvalid',
    'msgTooFast',
    'msgRate',
    'msgUnavailable',
    'msgNetwork',
    'msgForbidden',
    'msgGeneric',
    'msgSession',
    'summaryFieldsH',
    'summaryFailH',
    'summaryNetworkH',
    'statusErrors',
    'statusSending',
  ];
  const msgs = msgKeys
    .map((k) => [k, f[k]])
    .map(([k, v]) => `<span data-msg="${k}">${esc(v)}</span>`)
    .join('\n');
  return `<div class="wrap prose signup">
<h1 id="su-h1">${rich(pg.h1, lang)}</h1>
<p class="lead" id="su-intro-extra">${rich(pg.lead, lang)}</p>
<p class="notice" id="su-nojs">${rich2(f.nojs, lang)}${v ? ` ${rich2(v.nojsConfirm, lang)}` : ''}</p>
<div hidden>
${msgs}
</div>
<div id="su-status" class="visually-hidden" role="status" aria-live="polite" aria-atomic="true"></div>
${v ? '<div id="su-flow">\n' : ''}<form id="signup-form" method="post" action="${esc(SIGNUP_API_BASE)}/web" novalidate hidden data-api="${esc(SIGNUP_API_BASE)}" data-lang="${lang}" aria-labelledby="su-h1">
<div id="su-summary" class="summary" role="group" aria-labelledby="su-summary-h" tabindex="-1" hidden>
<h2 id="su-summary-h"></h2>
<p id="su-summary-msg" hidden></p>
<ul id="su-summary-list"></ul>
</div>
<p>${esc(f.required)}</p>
${field('name', f.name, '<input type="text" id="su-name" name="name" autocomplete="name" maxlength="80" dir="auto" aria-required="true">')}
${field('email', f.email, '<input type="email" id="su-email" name="email" autocomplete="email" inputmode="email" dir="ltr" maxlength="254" spellcheck="false" autocapitalize="off" aria-required="true" aria-describedby="su-hint-email">', f.emailHint)}
${field('role', f.role, `<select id="su-role" name="role" aria-required="true">\n${opts(SIGNUP_ROLE_VALUES, f.roles, f.rolePick)}\n</select>`)}
${field('heard', f.heard, '<input type="text" id="su-heard" name="heardFrom" maxlength="80" autocomplete="off" dir="auto" aria-describedby="su-hint-heard">', f.heardHint, ` <span class="optional">${esc(f.optional)}</span>`)}
<div class="hp" aria-hidden="true" inert>
<label for="su-website">${esc(f.honeypot)}</label>
<input type="text" id="su-website" name="website" value="" tabindex="-1" autocomplete="off" aria-hidden="true" data-lpignore="true" data-1p-ignore="true">
</div>
<h2 class="small-h">${esc(f.privacyH)}</h2>
${f.privacy.map((x) => `<p>${rich2(x, lang)}</p>`).join('\n')}
${check('age', esc(f.age))}
${check('consent', `${esc(f.consentBefore)}<a href="${privacyHref}" target="_blank" rel="noopener">${esc(f.consentLink)}<span class="visually-hidden"> ${esc(f.newTab)}</span></a>${rich(f.consentAfter, lang)}`)}
<p><button type="submit" class="btn btn-primary" id="su-submit" aria-disabled="false"><span data-label>${esc(f.submit)}</span></button></p>
<p id="su-sending" class="hint-text" aria-hidden="true" hidden>${esc(f.statusSending)}</p>
</form>
<section id="su-success" hidden>
<h2 id="su-success-h" tabindex="-1">${rich(f.successH, lang)}</h2>
${f.successP.map((x) => `<p>${rich2(x, lang)}</p>`).join('\n')}
</section>
${v ? `</div>\n${renderVerifyView(lang, f, v)}\n` : ''}<script type="module" src="/assets/signup.mjs"></script>
</div>`;
}

function renderPage(lang, page, opts) {
  const applyUrl = checkApplyUrl(opts.applyUrl);
  // signupVerify implies the own sign-up page on every page, so its preview shows the site as the flip builds it.
  const signupOn = opts.signupEnabled || opts.signupVerify;
  const t = content[lang];
  const other = content[t.switchToLang];
  const pg = t.pages[page];
  const sections = opts.signupVerify
    ? verifySections(pg.sections, t.signupVerify.pages[page])
    : pg.sections;
  // A page whose flip copy changes what it covers also overrides the meta description.
  const description = (opts.signupVerify && t.signupVerify.descriptions?.[page]) || pg.description;
  const nav = (signupOn ? [...NAV_PAGES, 'signup'] : NAV_PAGES)
    .map((n) => {
      const cur = n === page ? ' aria-current="page"' : '';
      return `<li><a href="${pagePath(lang, n)}"${cur}>${esc(t.navNames[n])}</a></li>`;
    })
    .join('\n');
  const foot = FOOTER_PAGES.map((n) => {
    const cur = n === page ? ' aria-current="page"' : '';
    return `<li><a href="${pagePath(lang, n)}"${cur}>${esc(t.footerNames[n])}</a></li>`;
  }).join('\n');
  const alts = LANGS.map(
    (l) => `<link rel="alternate" hreflang="${l}" href="${pagePath(l, page)}">`,
  ).join('\n');
  const signIn = (cls) =>
    `<a class="${cls}" href="${LAB_URL}" rel="noopener">${esc(t.signIn)}<span class="hint"> (${esc(t.signInHint)})</span></a>`;
  const cta = (where) =>
    signupOn
      ? `<a class="btn btn-primary" href="${pagePath(lang, 'signup')}">${esc(t.applyOpen)}</a>`
      : applyUrl
        ? `<a class="btn btn-primary" href="${applyUrl}" rel="noopener">${esc(t.applyOpen)}</a>`
        : `<a class="btn btn-pending" href="${pagePath(lang, 'alpha')}#how-to-apply" aria-describedby="apply-hint-${where}"><span>${esc(t.applyPending)}</span><span class="visually-hidden">. </span><span class="btn-sub">${esc(t.applyPendingNote)}</span></a>
<span class="visually-hidden" id="apply-hint-${where}">${esc(t.applyHint)}</span>`;

  let body;
  if (page === 'home') {
    const shots = SCREENSHOTS.length
      ? `<section class="band">
<div class="wrap">
<h2 id="screenshots" tabindex="-1">${esc(t.screenshotsH)}</h2>
<ul class="shots" role="list">
${SCREENSHOTS.map((i) => `<li><figure><img src="${i.src}" width="${i.width}" height="${i.height}" alt="${esc(i.alt[lang])}" loading="lazy"><figcaption>${esc(i.caption[lang])}</figcaption></figure></li>`).join('\n')}
</ul>
</div>
</section>`
      : '<!-- screenshots section: filled from SCREENSHOTS in content.mjs (slice B) -->';
    body = `<div class="hero">
<div class="wrap">
<p class="eyebrow" lang="${t.descriptorLang}" dir="ltr">${esc(t.descriptor)}</p>
<h1>${rich(pg.h1, lang)}</h1>
<p class="value">${rich(pg.lead, lang)}</p>
<p class="cta-row">${cta('hero')}</p>
<p class="req">${esc(t.desktopNote)}</p>
</div>
</div>
<section class="band">
<div class="wrap">
<h2 id="features" tabindex="-1">${esc(pg.featuresH)}</h2>
<ul class="cards" role="list">
${pg.features.map((f) => `<li class="card"><h3>${rich(f.h, lang)}</h3><p>${rich(f.p, lang)}</p></li>`).join('\n')}
</ul>
</div>
</section>
${shots}
${sections.map((s) => `<div class="wrap prose">${renderSection(s, 2, lang)}</div>`).join('\n')}
<div class="wrap prose join">
<p class="cta-row">${cta('band')}</p>
<p>${signIn('signin')}</p>
</div>`;
  } else if (page === 'signup') {
    body = renderSignupBody(lang, t, pg, opts.signupVerify);
  } else if (LEGAL_PAGES.includes(page)) {
    body = `<div class="wrap prose">
<h1>${esc(pg.h1)}</h1>
${page === 'privacy' ? `<p class="draft">${esc(t.interimNote)}</p>` : ''}
${sections.map((s) => renderSection(signupOn && s.pOwn ? { ...s, p: s.pOwn } : s, 2, lang)).join('\n')}
</div>`;
  } else {
    const how = (s) => {
      if (s.id !== 'how-to-apply') return s;
      if (signupOn) return { ...s, p: s.pOpenOwn };
      return { ...s, p: applyUrl ? s.pOpen : s.pPending };
    };
    body = `<div class="wrap prose">
<h1>${esc(pg.h1)}</h1>
${pg.lead ? `<p class="lead">${rich(pg.lead, lang)}</p>` : ''}
${sections
  .map((s) => {
    const r = renderSection(how(s), 2, lang);
    if (s.id === 'how-to-apply')
      return applyUrl || signupOn
        ? r.replace('</section>', `<p class="cta-row">${cta('alpha')}</p>\n</section>`)
        : r;
    if (s.id === 'tester-sign-in')
      return r.replace('</section>', `<p>${signIn('signin')}</p>\n</section>`);
    return r;
  })
  .join('\n')}
</div>`;
  }

  return `<!doctype html>
<html lang="${t.lang}" dir="${t.dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(plain(pg.title))}</title>
<meta name="description" content="${esc(plain(description))}">
${ogTags({ url: pagePath(lang, page), title: plain(pg.title), description: plain(description), locale: OG_LOCALE[lang] ?? lang, altLocale: OG_LOCALE[t.switchToLang] })}
${alts}
${page === 'signup' && opts.signupNoindex ? '<meta name="robots" content="noindex">\n' : ''}<link rel="icon" href="/assets/favicon.ico" sizes="any">
<link rel="icon" type="image/png" href="/assets/favicon-32.png" sizes="32x32">
<link rel="stylesheet" href="/assets/site.css">
</head>
<body>
<a class="skip" href="#main">${esc(t.skip)}</a>
<header>
<div class="wrap bar">
<p class="brand"><a href="${pagePath(lang, 'home')}"><img src="/assets/tbi-lab-logo.png" width="56" height="32" alt="">${esc(t.siteName)}</a></p>
<nav aria-label="${esc(t.navLabel)}">
<ul role="list">
${nav}
<li><a href="${pagePath(t.switchToLang, page)}" hreflang="${t.switchToLang}" lang="${other.lang}">${esc(t.switchTo)}</a></li>
</ul>
</nav>
</div>
</header>
<main id="main" tabindex="-1">
${body}
</main>
<footer>
<div class="wrap foot">
<nav aria-label="${esc(t.footerLabel)}">
<ul role="list">
${foot}
<li>${signIn('signin')}</li>
</ul>
</nav>
<p>${esc(t.contactLabel)}: ${mail}</p>
<p class="copy"><small>${esc(t.brand)}</small></p>
</div>
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
${ogTags({ url: '/', title: 'TBI Lab — Electronics Engineering Workspace', description: 'An electronics and classic ESP32 lab in your browser, with Arduino (C++) and MicroPython. Free Alpha, limited places.', locale: 'he_IL', altLocale: 'en_US' })}
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

/**
 * `signupPreview` (e2e / local preview only, never the published build): also build the sign-up page while the flag
 * is off. It is unlinked, so every other page is byte-identical to a build without it.
 * `signupVerify` (default SIGNUP_VERIFY_ENABLED, OFF until the owner's flip): the sign-up pages get the Google-account and
 * confirm-your-email copy, the confirm view and the resend form, and assets/signup.mjs gets site/signup-verify.mjs
 * appended (one module, so the publish script gate is unchanged). The home, alpha, FAQ and accessibility pages get the
 * `signupVerify.pages` copy, and every page is built as with the sign-up page enabled (also in the preview). Without
 * `signupPreview` it requires the sign-up page to be enabled: any other combination is refused, so a flip cannot be
 * silently without effect.
 * `signupNoindex` (default SIGNUP_NOINDEX): robots noindex on the sign-up pages, independent of the flag.
 */
export function buildSite(outDir = join(here, 'dist'), opts = {}) {
  const o = {
    applyUrl: APPLY_URL,
    signupEnabled: SIGNUP_PAGE_ENABLED,
    signupPreview: false,
    signupVerify: SIGNUP_VERIFY_ENABLED,
    signupNoindex: SIGNUP_NOINDEX,
    ...opts,
  };
  // Checked before the output directory is touched.
  if (o.signupVerify && !o.signupEnabled && !o.signupPreview)
    throw new Error(
      'site build refused: email confirmation (SIGNUP_VERIFY_ENABLED) needs the sign-up page (SIGNUP_PAGE_ENABLED)',
    );
  // Flag off (and no preview): no sign-up page and no client script at all (review finding 8).
  const withSignup = o.signupEnabled || o.signupPreview;
  const out = resolve(outDir);
  rmSync(out, { recursive: true, force: true });
  const write = (rel, data) => {
    const f = join(out, rel);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, data);
  };
  write('index.html', renderRoot());
  for (const lang of LANGS)
    for (const page of withSignup ? [...PAGES, 'signup'] : PAGES)
      write(`${lang}${pagePath(lang, page).slice(3)}index.html`, renderPage(lang, page, o));
  mkdirSync(join(out, 'assets'), { recursive: true });
  copyFileSync(join(here, 'site.css'), join(out, 'assets', 'site.css'));
  if (withSignup) {
    const module = join(out, 'assets', 'signup.mjs');
    copyFileSync(join(here, 'signup.mjs'), module);
    if (o.signupVerify)
      appendFileSync(module, '\n' + readFileSync(join(here, 'signup-verify.mjs')));
  }
  // Self-hosted Heebo (SIL OFL 1.1, see site/fonts/OFL-Heebo.txt): consistent look, no third-party requests.
  mkdirSync(join(out, 'assets', 'fonts'), { recursive: true });
  for (const f of [
    'heebo-hebrew-wght-normal.woff2',
    'heebo-latin-wght-normal.woff2',
    'OFL-Heebo.txt',
  ])
    copyFileSync(join(here, 'fonts', f), join(out, 'assets', 'fonts', f));
  mkdirSync(join(out, 'assets', 'images'), { recursive: true });
  for (const i of SCREENSHOTS) {
    const f = i.src.split('/').pop();
    copyFileSync(join(here, 'images', f), join(out, 'assets', 'images', f));
  }
  copyFileSync(join(BRAND_DIR, 'tbi-lab-logo.png'), join(out, 'assets', 'tbi-lab-logo.png'));
  mkdirSync(join(out, 'assets', 'og'), { recursive: true });
  copyFileSync(
    join(here, 'images', 'og-preview.png'),
    join(out, 'assets', 'og', 'tbi-lab-preview.png'),
  );
  for (const f of ['favicon.ico', 'favicon-32.png'])
    copyFileSync(join(BRAND_DIR, 'icons', 'production', f), join(out, 'assets', f));
  return out;
}

/**
 * Build options from the command line. Only what was asked for is returned, so the content.mjs constants stay the
 * defaults.
 * --signup-preview: see buildSite. --signup-verify: preview of the G1-AUTO-VERIFY site (implies --signup-preview),
 * never for publishing; the published build follows SIGNUP_VERIFY_ENABLED only (no environment variable).
 * SITE_SIGNUP_ENABLED=1 builds the flag-true (flip) variant of the page flag for e2e checks.
 */
export function cliOptions(args, env) {
  const verify = args.includes('--signup-verify');
  return {
    signupPreview: verify || args.includes('--signup-preview'),
    ...(verify ? { signupVerify: true } : {}),
    ...(env.SITE_SIGNUP_ENABLED === '1' ? { signupEnabled: true } : {}),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  const out = buildSite(dir, cliOptions(args, process.env));
  console.log(`site built: ${out} (default language ${DEFAULT_LANG})`);
}

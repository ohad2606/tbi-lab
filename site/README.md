# TBI public site (TBI-013, slice 1)

Static, pre-rendered, dependency-free site: Hebrew (`/he/`, default, RTL) and English (`/en/`), plus a
static language-pair page at `/`. No third-party fonts or scripts. The only client script is the sign-up page's `signup.mjs` (own, ES module).
Pages: Home, Product, Alpha program, FAQ, Privacy (interim notice) and Accessibility statement (short, honest, no
conformance claim). No Terms page until a lawyer reviews one. Config constants in `content.mjs`: `APPLY_URL`
(empty = "registration opens soon"; https only = CTA links to it), `LAB_URL` (tester sign-in), `CONTACT_EMAIL`,
`SCREENSHOTS` (empty = no section; slice B fills it). Colour contrast is computed in `tests/contrast.test.mjs`.

## Layout

- `content.mjs` — all copy, `he` and `en` objects with identical keys; `[[TOKEN]]` marks an LTR technical token.
- `build.mjs` — generator (`buildSite(outDir)`); `site.css` — one stylesheet, logical properties only.
- `serve.mjs` — tiny static server (used by the e2e config; sends a strict CSP).
- `tests/` (vitest, generator), `e2e/a11y-site.spec.ts` (Playwright + axe-core).

## Commands

- Build: `npm run site:build` (output `site/dist/`, gitignored; brand files are copied from `app/src/assets/brand`).
- Unit: `npx vitest run site`
- E2E (take the pipeline lock first): `npm run site:test:e2e` (`playwright.site.config.ts`, port 4391).

Automated checks (axe-core, own checks) do not establish WCAG conformance; screen-reader and manual
review are still required. Publishing the accessibility statement, privacy policy and terms needs legal review.

Deployment is an owner decision and has not been done.

## Own sign-up page (BETA-G1 s9)

`/he/signup/` and `/en/signup/` are always built. While `SIGNUP_PAGE_ENABLED` (content.mjs) is `false` they are
`noindex` and linked from nowhere; the home CTA keeps `APPLY_URL`. Flipping the flag adds the nav link, points the
CTAs at the page and drops noindex. `SIGNUP_API_BASE` (default `/signup`, same origin) is the intake base: the page
calls `GET <base>/form-token` and `POST <base>/web`. The web server must proxy those two paths (see
`docs/plans/BETA-G1-WEB-INTAKE.md`) and its CSP must allow `script-src 'self'; connect-src 'self'` (as `serve.mjs`
does). `signup.mjs` holds only logic; all text is rendered by the generator. Tests: `tests/signup.test.mjs`,
`e2e/a11y-signup.spec.ts` (API stubbed with route interception).

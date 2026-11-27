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
- `serve.mjs` — tiny static server (used by the e2e config; sends the strict CSP from `csp.mjs`).
- `deploy/` — sign-up site Caddy template + renderer (G1; not deployed; see `docs/ops/G1-SIGNUP-PROXY.md`).
- `tests/` (vitest, generator), `e2e/a11y-site.spec.ts` (Playwright + axe-core).

## Commands

- Build: `npm run site:build` (output `site/dist/`, gitignored; brand files are copied from `app/src/assets/brand`).
- Unit: `npx vitest run site`
- E2E (take the pipeline lock first): `npm run site:test:e2e` (`playwright.site.config.ts`, port 4391).

Automated checks (axe-core, own checks) do not establish WCAG conformance; screen-reader and manual
review are still required. Publishing the accessibility statement, privacy policy and terms needs legal review.

Deployment is an owner decision and has not been done.

## Own sign-up page (BETA-G1 s9)

While `SIGNUP_PAGE_ENABLED` (content.mjs) is `false`, `/he/signup/`, `/en/signup/` and `assets/signup.mjs` are not
built at all and every other page is byte-identical to the site without the sign-up work (checked against co/main
hashes in `tests/signup-review-fixes.test.mjs`); the home CTA keeps `APPLY_URL`. `node site/build.mjs --signup-preview`
(e2e and local preview only, never for publishing) builds the page anyway, linked from nowhere.
Flipping the flag builds the page, adds the nav link, points the CTAs at the page and switches the privacy text to
the own-form wording (draft, lawyer review required). `SITE_SIGNUP_ENABLED=1 node site/build.mjs <dir>` builds that
variant for checks only. The sign-up pages are `noindex` in both modes while `SIGNUP_NOINDEX` (content.mjs) is
`true`; it is set to `false` on the public launch day only. The page waits
the server's `minFill` after a token arrives before posting (`tests/signup-contract.test.mjs` runs the real client
against the real intake). `SIGNUP_API_BASE` (default `/signup`, same origin) is the intake base: the page
calls `GET <base>/form-token` and `POST <base>/web`. The web server must proxy those two paths (see
`docs/plans/BETA-G1-WEB-INTAKE.md`) and its CSP must allow `script-src 'self'; connect-src 'self'` (as `serve.mjs`
does). `signup.mjs` holds only logic; all text is rendered by the generator. Tests: `tests/signup.test.mjs`,
`e2e/a11y-signup.spec.ts` (API stubbed with route interception).

Email confirmation (G1-AUTO-VERIFY): `SIGNUP_VERIFY_ENABLED` (content.mjs, `false`) is the flip switch. `true` puts
the confirm view and resend form into the sign-up pages of the published build and needs `SIGNUP_PAGE_ENABLED = true`
(the build refuses otherwise). No environment variable changes it. `node site/build.mjs <dir> --signup-verify` builds
the same views as a preview only, never for publishing. The privacy, consent, home and FAQ wording does not change
with this switch.

# TBI public site (TBI-013, slice 1)

Static, pre-rendered, dependency-free site: Hebrew (`/he/`, default, RTL) and English (`/en/`), plus a
static language-pair page at `/`. No client JavaScript, no third-party fonts or scripts, no forms.
Pages: Home, Product, Alpha program, FAQ, and Privacy / Terms / Accessibility statement as
**placeholders** ("Draft — will be published after legal review"). No legal text is written here.
The Apply button is a plain link to the Alpha page section "how to apply" (applications are not open).

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

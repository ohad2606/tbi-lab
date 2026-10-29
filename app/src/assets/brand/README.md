# TBI Lab brand assets

Derived from the official TBI Lab logo package provided by the owner (`~/logo/logo_app`,
2026-10-14; not committed, 1.3–1.9 MB each) by `scripts/build-brand-assets.mjs` (the top-bar and Projects images with
Chromium's canvas; the application icons with `scripts/brand-image.mjs`, Node only, Lanczos-3 in
linear light, byte-deterministic). The artwork is used exactly as supplied: nothing is
recoloured, redrawn or made transparent; transparent files are only trimmed to their
non-transparent pixels and scaled with the aspect ratio kept.

| Asset                           | Source (SHA-256)                      | Use                                                                                          |
| ------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `tbi-lab-symbol.png` (135 × 76) | `app_logo_04.png` (`17bd314b…1f8dfa`) | the infinity symbol alone, transparent; top bar at 38 px beside the product name (2x)        |
| `tbi-lab-logo.png` (520 × 300)  | `app_logo_01.png` (`e6efd96a…bdc4fc`) | the full logo (symbol, TBI LAB wordmark, tagline), transparent; Projects band at 150 px (2x) |
| `icons/<env>/…` (see below)     | `app_logo_04.png`, `app_logo_05.png`  | favicons, apple-touch-icon, web app manifest icons (`app/brand.config.ts`)                   |

**The package (2026-10-14).** 14 PNGs in two parallel sets, `logo_main/` and `logo_app/`; no SVG,
ICO or small-size variants. The owner selected `logo_app/` for the application:

| File              | Size        | Content                                                             |
| ----------------- | ----------- | ------------------------------------------------------------------- |
| `app_logo_01.png` | 1672 × 941  | full logo with tagline, transparent. **Used**                       |
| `app_logo_02.png` | 1672 × 941  | full logo with tagline on a painted navy background                 |
| `app_logo_03.png` | 1672 × 941  | full logo with tagline on a painted white background                |
| `app_logo_04.png` | 1672 × 941  | infinity symbol only, transparent. **Used**                         |
| `app_logo_05.png` | 1254 × 1254 | dark rounded app icon (symbol + TBI LAB), painted corners. **Used** |
| `app_logo_06.png` | 1254 × 1254 | light rounded app icon (symbol + TBI LAB), painted corners          |
| `app_logo_07.png` | 2172 × 724  | wide banner with decorative background art; no placement            |

**Application icons (2026-10-29).** The retired `tbi-lab-favicon.png` (64 × 64, the only icon link)
was upscaled by every surface larger than a tab: the iPad/Android home screen (180–192 px) and the
browser UI had nothing else, so they were soft. Now, per environment (`production/`, and `dev/` with
a yellow DEV marker, used only by DEV-Lab builds, `VITE_TBI_ENV=dev`):

| File                                                       | Source                                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `favicon-16.png`, `favicon-32.png`                         | `app_logo_04` symbol alone (the app icon is illegible there)                 |
| `apple-touch-icon-180.png`, `icon-192.png`, `icon-512.png` | `app_logo_05` cropped to its rounded square (x/y 48..1205)                   |
| `maskable-192.png`, `maskable-512.png`                     | whole `app_logo_05` at 70 %, edge pixels extended: inside the 80 % safe zone |

`app/brand.config.ts` emits them with content-hashed names, links them from `index.html` and
writes the web app manifest.

Known limitations, reported to the owner: the package has no small-size favicon (the detailed app
icon is hard to read at 16–32 px, and its corners are painted black, not transparent), and no
transparent "TBI LAB without tagline" lock-up (the top bar therefore shows the symbol beside the
existing text name). In the transparent originals the artwork reaches the bottom edge (no built-in
clear space); the surrounding layout provides it.

Re-run `node ../scripts/build-brand-assets.mjs ~/logo/logo_app` from `app/` to regenerate; the
originals are not committed. The previous generic TBI assets (`tbi-logo.png`, `tbi-logo-light.png`,
`tbi-mark.png`, from `~/TBI_logo`) are retired.

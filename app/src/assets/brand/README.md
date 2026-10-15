# TBI Lab brand assets

Derived from the official TBI Lab logo package provided by the owner (`~/logo/logo_app`,
2026-10-14; not committed, 1.3–1.9 MB each) by `scripts/build-brand-assets.mjs`, which uses
Chromium's canvas for high-quality downscaling. The artwork is used exactly as supplied: nothing is
recoloured, redrawn or made transparent; transparent files are only trimmed to their
non-transparent pixels and scaled with the aspect ratio kept.

| Asset                           | Source (SHA-256)                      | Use                                                                                          |
| ------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `tbi-lab-symbol.png` (135 × 76) | `app_logo_04.png` (`17bd314b…1f8dfa`) | the infinity symbol alone, transparent; top bar at 38 px beside the product name (2x)        |
| `tbi-lab-logo.png` (520 × 300)  | `app_logo_01.png` (`e6efd96a…bdc4fc`) | the full logo (symbol, TBI LAB wordmark, tagline), transparent; Projects band at 150 px (2x) |
| `tbi-lab-favicon.png` (64 × 64) | `app_logo_05.png` (`282b09a8…ade1`)   | the dark app icon, scaled; browser-tab icon (`index.html`). **Interim**: see below           |

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

Known limitations, reported to the owner: the package has no small-size favicon (the detailed app
icon is hard to read at 16–32 px, and its corners are painted black, not transparent), and no
transparent "TBI LAB without tagline" lock-up (the top bar therefore shows the symbol beside the
existing text name). In the transparent originals the artwork reaches the bottom edge (no built-in
clear space); the surrounding layout provides it.

Re-run `node ../scripts/build-brand-assets.mjs ~/logo/logo_app` from `app/` to regenerate; the
originals are not committed. The previous generic TBI assets (`tbi-logo.png`, `tbi-logo-light.png`,
`tbi-mark.png`, from `~/TBI_logo`) are retired.

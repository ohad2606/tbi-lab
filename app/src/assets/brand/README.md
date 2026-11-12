# TBI Lab brand assets

Derived from the official TBI Lab logo package provided by the owner (`~/logo/logo_app`,
2026-10-14; not committed, 1.3–1.9 MB each) by `scripts/build-brand-assets.mjs` (the top-bar and Projects images with
Chromium's canvas; the application icons with `scripts/brand-image.mjs`, Node only, Lanczos-3 in
linear light, byte-deterministic). Nothing is recoloured or redrawn; transparent files are only trimmed to their
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

**Application icons (revised 2026-11-05).** Per environment (`production/`, and `dev/` with a yellow DEV marker, used only by
DEV-Lab builds, `VITE_TBI_ENV=dev`). A desktop scales its taskbar and shortcut icons down from what the manifest lists, so
every size it uses is supplied, made for that size:

| File                                                  | Content                                                                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `favicon-16.png`, `favicon-24.png`                    | `app_logo_04` symbol on the app icon's navy rounded square (the wordmark cannot resolve; the symbol alone washes out on light backgrounds) |
| `favicon-32/48/64.png`, `icon-96/128/192/256/512.png` | `app_logo_05`, transparent outside its measured rounded square, sharpened after the reduction                                              |
| `favicon.ico`                                         | 16, 24, 32, 48, 64, 256 of the above                                                                                                       |
| `apple-touch-icon-180.png`                            | `app_logo_05` cropped to its rounded square, opaque (iOS masks it)                                                                         |
| `maskable-192.png`, `maskable-512.png`                | the content of `app_logo_05` on the brand navy, as large as the 80 % safe zone allows                                                      |

DEV marker: up to 96 px the symbol on the square with a yellow band (a band over the wordmark would leave pieces of its
letters); above that a yellow ring and DEV on the LAB plate; maskable and apple-touch-icon, the symbol on the navy with a yellow band (a ring would be masked away on iOS).

The only pixels removed from the artwork are the painted black around the rounded square (on the maskable icons, the outline with it); nothing is recoloured or redrawn.

Known limitations, reported to the owner: the package has no small-size favicon (the detailed app
icon is hard to read at 16–32 px, and its corners are painted black, not transparent), and no
transparent "TBI LAB without tagline" lock-up (the top bar therefore shows the symbol beside the
existing text name). In the transparent originals the artwork reaches the bottom edge (no built-in
clear space); the surrounding layout provides it.

Re-run `node ../scripts/build-brand-assets.mjs ~/logo/logo_app` from `app/` to regenerate; the
originals are not committed. The previous generic TBI assets (`tbi-logo.png`, `tbi-logo-light.png`,
`tbi-mark.png`, from `~/TBI_logo`) are retired.

The same script also writes the TBI Admin app's home-screen icons, `admin-app/public/icon-192.png`
and `icon-512.png` (192 and 512 px), from the same dark app icon `app_logo_05.png` (admin app
design §3).

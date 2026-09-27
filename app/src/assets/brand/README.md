# TBI brand assets

Derived from the TBI logo files provided by the PM (`~/TBI_logo`, 2026-09-24; not committed,
1.1–1.4 MB each) by `scripts/build-brand-assets.mjs`, which uses Chromium's canvas for
high-quality downscaling:

| Asset                            | Source (SHA-256)                       | Treatment                                                                                                                                                                      |
| -------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tbi-mark.png` (128 px)          | `logo_rounded.png` (`c0c19526…8cfe7f`) | clipped to its circle, transparent outside; top bar at 30 px                                                                                                                   |
| `tbi-logo.png` (533 × 300)       | `logo_main.png` (`0ef14ee2…677943`)    | auto-cropped to the artwork; its painted navy background turned into real alpha (see below); Projects header at 150 px (2x)                                                    |
| `tbi-logo-light.png` (204 × 120) | `logo_no_bg.png` (`64f0ace5…fa35dc6`)  | same logo drawn for light surfaces: auto-cropped; its painted light checkerboard cleared by colour-to-alpha (dark-on-light); top bar at 38 px; also the favicon (`index.html`) |

**Source inspection (Product Alpha maintenance, 2026-09-24).** All four originals are 8-bit RGB PNGs
with no alpha channel:

| File               | SHA-256                                                            | Finding                                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `logo_no_bg.png`   | `64f0ace553638130d8ce95587107ebbc26dfdeb154df284d85e8bfd48fa35dc6` | **No real transparency.** Alpha 255 everywhere; a checkerboard (≈248 / ≈252 grey, ~20 px blocks) is painted into the pixels. **Used** (S6) for `tbi-logo-light.png`: the checkerboard is below the 6 % floor and cleared. |
| `logo_main.png`    | `0ef14ee29603371d04ecaaaa004f1d5b6ee0e5cb4cc0e6704d5b68b69d677943` | Elongated logo on a near-black navy (≈ rgb(0, 9, 30)). **Used** for `tbi-logo.png`                                                                                                                                        |
| `logo_banner.png`  | `1be0447d2042065d602fc2e5153e13e75961555f7abf86c054e39c1e17689e1f` | Wide banner with decorative background art; not a logo lock-up                                                                                                                                                            |
| `logo_rounded.png` | `c0c1952620c423dc032c6b78b167dbe024ac72d020316422491469a6cf8cfe7f` | Round (profile) mark; `tbi-mark.png` kept as a profile asset, used nowhere in the product UI (S6)                                                                                                                         |

`tbi-logo.png` is `logo_main.png` with its background made transparent by colour-to-alpha against
the measured background colour (every pixel is un-blended as artwork over that background; only
brightness above it counts, and the background's own grain below 3 % opacity is cleared). The
artwork is not redrawn or recoloured: composited on the navy header it reproduces the original,
without a visible box. Re-run `node ../scripts/build-brand-assets.mjs ~/TBI_logo` from `app/`
to regenerate; the originals are not committed.

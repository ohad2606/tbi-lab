# TBI brand assets

Derived from the TBI logo files provided by the PM (`~/TBI_logo`, 2026-09-24; not committed,
1.1–1.4 MB each) by `scripts/build-brand-assets.mjs`, which uses Chromium's canvas for
high-quality downscaling:

| Asset                                 | Source (SHA-256)                       | Treatment                                                                         |
| ------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------- |
| `tbi-mark.png` (128 px)               | `logo_rounded.png` (`c0c19526…8cfe7f`) | clipped to its circle, transparent outside; top bar at 30 px                      |
| `../../../public/favicon.png` (64 px) | `logo_rounded.png`                     | same                                                                              |
| `tbi-logo.png` (355 × 200)            | `logo_main.png` (`0ef14ee2…677943`)    | auto-cropped to the artwork on its navy background; Projects brand band at 100 px |

The logo files have no real transparency: the "no background" variant has a painted
checkerboard, so it is not used. When final vector or transparent assets are available, re-run
the script (or replace these files) without code changes.

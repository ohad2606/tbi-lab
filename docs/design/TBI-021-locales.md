# TBI-021 slice 1: locale infrastructure

Scope: infrastructure only. Users still see HE and EN; es/fr/ar/ru are disabled stubs.

## Registry
`app/src/i18n/locales.ts` holds `LOCALE_REGISTRY: LocaleDef[]` (metadata only, no messages):
`code` (BCP 47 language subtag, also the `lang` attribute), `dir` (`ltr`|`rtl`), `autonym`,
`beta`, `enabled`. `i18n.ts` maps each message bundle to its registry entry; `LOCALES` is the
entries that are `enabled` AND have a bundle wired in. Enabling a language therefore needs
three things: a `messages.<code>.ts`, a `BUNDLES` entry, and `enabled: true`.

## Fallback chain
Per key: locale message -> English -> (never a raw key). `resolveMessages` fills any missing
or blank key from English at build time, so `LocaleInfo.messages` is always complete and
`translate()` stays a plain lookup. Unknown/disabled locale code -> `en` (`getLocale`).
Glossary terms are applied to the locale's own messages first; English fills in already resolved.

## dir and lang
`dir` comes from the registry: `he` and `ar` are `rtl`, the rest `ltr`. `App.tsx` already sets
`document.documentElement.lang/dir` from the active locale; no `if (lang === ...)` anywhere.
Technical tokens (pins, values, code) stay LTR via the existing `<bdi>`/`isolateLtr` use.

## Beta labelling
Every new language ships `beta: true` until a native-speaking tester has reviewed it. The picker
(slice 2) shows a localized "beta" suffix next to the autonym; the autonym itself is never
translated. CLAIMS.md keeps saying HE/EN until a language is live on Alpha.

## Picker
Slice 2: the TopBar language control lists `LOCALES` (registered + enabled), not a hard-coded
pair; selected state via `aria-pressed`/`aria-current`, each option carries `lang=<code>` and
`dir` so screen readers pronounce the autonym correctly; the choice is announced politely.

## Key parity
`app/tests/i18n.test.ts` iterates `LOCALES` and asserts the exact English key set, non-empty
values and placeholders per locale, so a newly enabled locale is checked automatically
(this runs in CI under `npm test`). `i18n-registry.test.ts` checks registry invariants and fallback.
A locale in development may be partial while `enabled: false`; enabling requires full parity.

## Arabic glyph checks (later slice, before ar is enabled)
Arabic needs a font with Arabic coverage in every text surface: HTML UI, canvas labels,
SVG schematic, and 3D labels (HTML overlays in `renderer.ts`, forced `dir=ltr` for technical
text). Plan: add a font stack with a coverage check; an e2e visual spec per surface with
Arabic strings (shaping/joining, no tofu boxes, mixed-direction pin names); verify numerals
(Western digits for technical values) and `Intl` formatting with `ar` (default numbering
system may be Arabic-Indic; technical fields must force `latn`).

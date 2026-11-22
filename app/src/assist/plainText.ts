/**
 * TBI-017 s3 #8: text that comes from the service or the model is shown as plain text only:
 * bidi controls (LRM/RLM U+200E-F, ALM U+061C, embeddings/overrides U+202A-E, isolates
 * U+2066-9), zero-width characters (U+200B-D) and other control characters are dropped, so it
 * cannot reorder or hide the text around it. Newline and tab stay (the browser collapses them).
 * All format characters (\p{Cf}: also U+2060-F, U+FEFF, U+00AD, tag characters), U+2028/9, variation
 * selectors and invisible fillers are dropped too (review: they can hide text).
 * U+200D (ZWJ) is dropped too: this text has no emoji sequences to keep.
 */
// prettier-ignore
const CONTROLS = /[\p{Cf}\u2028\u2029\u3164]|\u034F|[\uFE00-\uFE0F]|[\u{E0100}-\u{E01EF}]|(?![\n\t])\p{Cc}/gu;

export function stripControls(raw: string): string {
  return raw.replace(CONTROLS, '');
}

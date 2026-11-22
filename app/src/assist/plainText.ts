/**
 * TBI-017 s3 #8: text that comes from the service or the model is shown as plain text only:
 * bidi controls (LRM/RLM U+200E-F, ALM U+061C, embeddings/overrides U+202A-E, isolates
 * U+2066-9), zero-width characters (U+200B-D) and other control characters are dropped, so it
 * cannot reorder or hide the text around it. Newline and tab stay (the browser collapses them).
 * U+200D (ZWJ) is dropped too: this text has no emoji sequences to keep.
 */
// prettier-ignore
const CONTROLS = /[\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069]|(?![\n\t])\p{Cc}/gu;

export function stripControls(raw: string): string {
  return raw.replace(CONTROLS, '');
}

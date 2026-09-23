/**
 * Canonical JSON (`tbi-lab.canonical-json.v1`): the byte form that content hashes are taken
 * over. Object keys are sorted by UTF-16 code unit order, there is no whitespace, strings and
 * numbers use ECMAScript `JSON.stringify` encoding (shortest round-trip number form), and the
 * text is hashed as UTF-8. Only JSON data is accepted: a non-finite number, `undefined`, a
 * function or any other non-JSON value is an error rather than being silently dropped.
 *
 * Locale never enters: this is the stored engineering data, not any presentation of it.
 */

export const CANONICALIZATION = 'tbi-lab.canonical-json.v1';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  throw new TypeError(`canonicalJson: not JSON data (${typeof value})`);
}

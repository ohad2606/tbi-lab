/**
 * BETA-G1 (gate G1): render the sign-up site's Caddyfile from Caddyfile.signup.template.
 * Offline helper only: it returns text and never writes, validates against a live config or
 * reloads anything (the live steps are owner-only, see docs/ops/G1-SIGNUP-PROXY.md).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEMPLATE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'Caddyfile.signup.template',
);
export const PLACEHOLDERS = ['SITE_HOST', 'SITE_ROOT', 'INTAKE_UPSTREAM', 'SOURCE_HEADER'];

/** Any whitespace, brace, quote, backslash, `#` or control character would break out of a token. */
const UNSAFE_CHARS = /[\s{}"'`\\#]/;
const unsafe = (v) =>
  UNSAFE_CHARS.test(v) || [...v].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

/**
 * @param {Record<string, string>} values  exactly the four PLACEHOLDERS
 * @param {{ variant?: 'tls' | 'plain', proxy?: boolean, template?: string }} [opts]
 *   variant `tls` (production, HSTS) or `plain` (http, no HSTS: loopback tests only);
 *   proxy=false is the rollback config (static only, both intake paths 404 from Caddy).
 */
export function renderCaddyfile(values, opts = {}) {
  const { variant = 'tls', proxy = true } = opts;
  let text = opts.template ?? readFileSync(TEMPLATE_PATH, 'utf8');
  const keys = Object.keys(values ?? {});
  for (const k of keys) if (!PLACEHOLDERS.includes(k)) throw new Error(`unknown placeholder ${k}`);
  for (const k of PLACEHOLDERS) {
    const v = values[k];
    if (typeof v !== 'string' || v === '') throw new Error(`missing value for ${k}`);
    if (unsafe(v)) throw new Error(`unsafe value for ${k}`);
  }
  if (!HEADER_NAME.test(values.SOURCE_HEADER)) throw new Error('unsafe value for SOURCE_HEADER');
  if (!proxy) {
    const out = text.replace(/^\t#proxy-begin\n[\s\S]*?^\t#proxy-end\n/m, '');
    if (out === text) throw new Error('template has no proxy block');
    text = out;
  }
  if (variant === 'plain') {
    text = text
      .split('\n')
      .filter((l) => !l.includes('#tls-only'))
      .join('\n')
      .replace('https://{{SITE_HOST}}', 'http://{{SITE_HOST}}');
  } else if (variant !== 'tls') throw new Error('variant must be tls or plain');
  for (const k of PLACEHOLDERS) text = text.split(`{{${k}}}`).join(values[k]);
  if (/\{\{[^}]*\}\}/.test(text)) throw new Error('unreplaced placeholder');
  return text;
}

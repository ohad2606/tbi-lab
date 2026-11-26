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

const DNS_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const HOSTNAME = new RegExp(`^(?=.{1,253}$)(?:${DNS_LABEL}\\.)*(?![0-9]+$)${DNS_LABEL}$`);
/** Absolute, not "/", segments of safe characters only, no `.` / `..` segment. */
const ABS_PATH = /^(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._+-]+)+\/?$/;
const LOOPBACK = /^(?:127\.0\.0\.1|\[::1\]|localhost):([1-9][0-9]{0,4})$/;

/** One allow-list per placeholder: anything not listed is refused. */
const ALLOWED = {
  SITE_HOST: (v) => HOSTNAME.test(v),
  SITE_ROOT: (v) => ABS_PATH.test(v),
  INTAKE_UPSTREAM: (v) => {
    const tcp = LOOPBACK.exec(v);
    if (tcp) return Number(tcp[1]) <= 65535;
    return v.startsWith('unix//') && v.endsWith('.sock') && ABS_PATH.test(v.slice('unix/'.length));
  },
  SOURCE_HEADER: (v) => /^X-Tbi-[A-Za-z0-9-]{1,58}$/.test(v),
};

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
    if (!ALLOWED[k](v)) throw new Error(`unsafe value for ${k}`);
  }
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

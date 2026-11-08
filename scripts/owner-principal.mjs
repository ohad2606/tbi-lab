#!/usr/bin/env node
/**
 * Sprint 23C, operator tool: the owner's principal, for the feedback-only release's owner
 * reference file (TBI_OWNER_PRINCIPAL_FILE; docs/alpha/ADMIN-AND-FEEDBACK.md).
 *
 *   sudo node scripts/owner-principal.mjs <identity-key-file> [--issuer google] < <file with the sub>
 *
 * Reads the Session Host's identity key from the file named as the argument, and the owner's
 * Google subject (`sub`, the decimal account id recorded for the owner) from STANDARD INPUT, never
 * from the command line: arguments are visible to every user in the process list and are kept in
 * shell history. Prints the principal and a newline, nothing else:
 *
 *   p_ + base64url(HMAC-SHA256(key, "<issuer>|<sub>"))[0..26)
 *
 * the derivation of runtime/identity/principal.ts (the issuer label is TBI_IDENTITY_ISSUER of the
 * deployment, `google` by default). The principal is an opaque HMAC: it is not the sub and does
 * not reveal it. No dependencies; plain Node. Exit status 2: usage; 1: bad key or subject.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** As runtime/identity/principal.ts: the gate's subject syntax; a Google sub is decimal. */
const SUBJECT_RE = /^[\x21-\x7e]{1,256}$/;
const GOOGLE_SUB_RE = /^\d{1,64}$/;
const ISSUER_RE = /^[a-z][a-z0-9.-]{0,31}$/;

export function derivePrincipal(key, issuer, subject) {
  if (!Buffer.isBuffer(key) || key.length < 32)
    throw new Error('identity key must be at least 32 bytes');
  if (!ISSUER_RE.test(issuer)) throw new Error('bad issuer label');
  if (!SUBJECT_RE.test(subject)) throw new Error('bad subject');
  const mac = createHmac('sha256', key).update(`${issuer}|${subject}`).digest('base64url');
  return `p_${mac.slice(0, 26)}`;
}

/** The subject from standard input: one line, surrounding whitespace removed. */
export function subjectFromInput(text, issuer) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length !== 1) throw new Error('standard input must hold exactly one subject');
  const sub = lines[0].trim();
  if (issuer === 'google' ? !GOOGLE_SUB_RE.test(sub) : !SUBJECT_RE.test(sub))
    throw new Error(issuer === 'google' ? 'a Google subject is decimal digits' : 'bad subject');
  return sub;
}

function main(argv) {
  const args = [...argv];
  let issuer = 'google';
  const at = args.indexOf('--issuer');
  if (at >= 0) {
    issuer = args[at + 1] ?? '';
    args.splice(at, 2);
  }
  if (args.length !== 1 || args[0].startsWith('-')) {
    process.stderr.write(
      'usage: owner-principal.mjs <identity-key-file> [--issuer LABEL] < file-with-the-sub\n' +
        '(the subject is read from standard input only, never from the command line)\n',
    );
    return 2;
  }
  if (process.stdin.isTTY)
    process.stderr.write('owner-principal: reading the subject from standard input\n');
  const key = readFileSync(args[0]);
  const sub = subjectFromInput(readFileSync(0, 'utf8'), issuer);
  process.stdout.write(`${derivePrincipal(key, issuer, sub)}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    // Never the subject or the key: the message only.
    process.stderr.write(`owner-principal: ${e.message}\n`);
    process.exitCode = 1;
  }
}

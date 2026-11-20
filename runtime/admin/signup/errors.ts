/** TBI-022: map any thrown error to a short class code. Never a message, path, URL or address. */
const KNOWN = /^[a-z][a-z0-9_]{1,31}$/;

export function errorClass(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'secret_missing';
  if (code === 'EACCES' || code === 'EPERM') return 'secret_unreadable';
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) return 'fs_error';
  // Our own coded errors (EmailError, StoreError, SecretError, notifier `http_500`, `network`).
  const m = e instanceof Error ? e.message : '';
  return KNOWN.test(m) ? m : 'error';
}

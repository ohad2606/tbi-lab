/**
 * Opaque random ids for projects and the device (32 lowercase hex characters, 128 random bits).
 *
 * Uses `crypto.getRandomValues`, which every browser provides in every context.
 * `crypto.randomUUID` is NOT used: it exists only in secure contexts (HTTPS or localhost), so an
 * app opened over plain HTTP on a LAN address or a dev hostname would fail to start.
 */
export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

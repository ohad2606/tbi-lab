/**
 * Sprint 23C: the owner reference of the feedback-only release (`TBI_ADMIN_MODE=reports`). No
 * helper and no access view exist there, so the Session Host learns who the owner is from one
 * root-provided file, `TBI_OWNER_PRINCIPAL_FILE`:
 *
 *   owner   root (uid 0)
 *   group   the Session Host's primary group (tbi-runtimeio)
 *   mode    exactly 0640, a regular file, one hard link, never a symlink
 *   content exactly one principal `p_` + 26 base64url characters, optionally one trailing newline
 *
 * The operator creates it once from the owner's recorded Google id with the existing derivation
 * (scripts/owner-principal.mjs). The file is read on every owner check (it is a few bytes), so a
 * replaced or removed file takes effect at once. Anything else (missing, unreadable, wrongly
 * owned, a wrong mode, a symlink, other content) makes the check `unavailable`: the admin routes
 * answer 503 and the rest of the app is unaffected (fail closed).
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isPrincipal, type Principal } from '../identity/principal.js';

/** Largest file accepted: one principal and a newline is 29 bytes. */
const MAX_BYTES = 64;

export interface OwnerFileExpect {
  /** Owning user id (default 0: root). */
  uid: number;
  /** Owning group id (default: this process's primary group). */
  gid: number;
}

export class OwnerReference {
  readonly expect: OwnerFileExpect;

  constructor(
    readonly path: string,
    expect: Partial<OwnerFileExpect> = {},
  ) {
    if (!path.startsWith('/')) throw new Error('TBI_OWNER_PRINCIPAL_FILE must be an absolute path');
    this.expect = { uid: expect.uid ?? 0, gid: expect.gid ?? process.getgid!() };
  }

  /** The owner principal, or null when the file is not exactly as specified (fail closed). */
  async principal(): Promise<Principal | null> {
    let fh: Awaited<ReturnType<typeof open>> | null = null;
    try {
      fh = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const st = await fh.stat();
      if (!st.isFile() || st.nlink !== 1 || st.size > MAX_BYTES) return null;
      if (st.uid !== this.expect.uid || st.gid !== this.expect.gid) return null;
      if ((st.mode & 0o7777) !== 0o640) return null;
      const buf = Buffer.alloc(MAX_BYTES + 1);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      if (bytesRead > MAX_BYTES) return null;
      const m = /^(p_[A-Za-z0-9_-]{26})\n?$/.exec(buf.subarray(0, bytesRead).toString('latin1'));
      return m && isPrincipal(m[1]) ? m[1] : null;
    } catch {
      return null;
    } finally {
      await fh?.close().catch(() => undefined);
    }
  }
}

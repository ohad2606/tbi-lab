/**
 * TBI-022: read a secret / key file and refuse one that other users can read. The mode is checked
 * on the OPENED descriptor (fstat), so a swap between check and read cannot pass the check.
 * Group-readable is allowed on purpose: the deploy design keeps secrets root-owned and readable
 * by the service's own group only (docs/alpha/SIGNUP-AUTOMATION-DESIGN.md, secret files).
 * The open never blocks on a FIFO (O_NONBLOCK). Raw fs errors are rethrown (callers map them with `errorClass`; they never log the message).
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export async function readSecretFile(file: string): Promise<string> {
  // O_NONBLOCK: opening a FIFO (or another special file) returns at once instead of blocking
  // until a writer appears; the fstat below then refuses it. No effect on a regular file.
  const fh = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error('secret_not_file');
    if ((st.mode & 0o007) !== 0) throw new Error('secret_unsafe_mode');
    return await fh.readFile('utf8');
  } finally {
    await fh.close();
  }
}

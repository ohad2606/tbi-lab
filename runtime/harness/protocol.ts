/**
 * TBI Lab runtime bridge protocol v1 (host side). The QEMU side is hw/misc/tbi_bridge.c
 * (runtime/qemu/patches). Parsing is strict: anything that is not exactly a v1 frame is a
 * protocol error, never skipped, so a corrupted stream cannot silently diverge.
 */

export type Level = 0 | 1;

export type Frame =
  | { type: 'H'; version: number; tickNs: bigint }
  | { type: 'G'; vns: bigint; pad: number; drive: Level; level: Level }
  | { type: 'T'; vns: bigint }
  | { type: 'S'; vns: bigint; bytes: Buffer };

export type Command =
  { type: 'I'; pad: number; level: Level } | { type: 'R'; bytes: Buffer } | { type: 'Q' };

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export const PADS = 40;
/** Bytes per serial-input command line (the QEMU side accepts up to 4096 pending). */
const R_CHUNK = 256;

export function parseFrame(line: string): Frame {
  let m: RegExpExecArray | null;
  if ((m = /^H tbi-bridge (\d+) (\d+)$/.exec(line))) {
    return { type: 'H', version: Number(m[1]), tickNs: BigInt(m[2]!) };
  }
  if ((m = /^G (\d+) (\d+) ([01]) ([01])$/.exec(line))) {
    const pad = Number(m[2]);
    if (pad >= PADS) throw new ProtocolError(`pad out of range: ${line}`);
    return {
      type: 'G',
      vns: BigInt(m[1]!),
      pad,
      drive: Number(m[3]) as Level,
      level: Number(m[4]) as Level,
    };
  }
  if ((m = /^T (\d+)$/.exec(line))) return { type: 'T', vns: BigInt(m[1]!) };
  if ((m = /^S (\d+) ((?:[0-9a-f]{2})+)$/.exec(line))) {
    return { type: 'S', vns: BigInt(m[1]!), bytes: Buffer.from(m[2]!, 'hex') };
  }
  throw new ProtocolError(`malformed frame: ${JSON.stringify(line.slice(0, 80))}`);
}

/** The reply to a frame: commands, then `C`. */
export function encodeReply(commands: readonly Command[]): string {
  let out = '';
  for (const c of commands) {
    if (c.type === 'I') {
      if (!Number.isInteger(c.pad) || c.pad < 0 || c.pad >= PADS) {
        throw new ProtocolError(`input command for invalid pad ${c.pad}`);
      }
      out += `I ${c.pad} ${c.level}\n`;
    } else if (c.type === 'R') {
      for (let i = 0; i < c.bytes.length; i += R_CHUNK) {
        out += `R ${c.bytes.subarray(i, i + R_CHUNK).toString('hex')}\n`;
      }
    } else {
      out += 'Q\n';
    }
  }
  return `${out}C\n`;
}

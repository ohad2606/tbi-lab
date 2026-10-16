/**
 * TBI Lab runtime bridge protocol (host side), versions 1 and 2 (ADR-011). The QEMU side is
 * hw/misc/tbi_bridge.c (runtime/qemu/patches). Parsing is strict: anything that is not exactly a
 * frame of the negotiated version is a protocol error, never skipped, so a corrupted stream cannot
 * silently diverge. Encoding is strict too: the host never emits a command QEMU would reject, so a
 * QEMU exit 3 always means a bug (ADR-011 §2).
 *
 * v2 adds, behind capability tokens announced in `H`:
 *   sched-input  `J <vns> <pad> <level>` / `X <pad>` (host -> QEMU, any reply)
 *   pad-func     `F <vns> <pad> <func> <od>`         (QEMU -> host, reply `C`)
 *   i2c          `B <vns> <bus> S|W|R|P ...`          (QEMU -> host, reply `K`/`D` then `C`)
 *   pwm          `P <vns> <timer> <state>`            (QEMU -> host, reply `C`; patch 0009)
 *                `W <vns> <signal> <state>`           LEDC high-speed timer / channel state
 */

export type Level = 0 | 1;

/** Capability tokens of bridge v2, in their canonical (sorted) order. */
export const CAPABILITIES = ['i2c', 'pad-func', 'pwm', 'sched-input'] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Routed function of a pad (patch 0007): simple GPIO, an I2C signal, or another peripheral. */
export type PadFunction =
  'gpio' | 'i2c0-scl' | 'i2c0-sda' | 'i2c1-scl' | 'i2c1-sda' | `periph:${number}`;

/** One I2C bus phase (patch 0008). Addresses are 7-bit; `read` is the R/W bit. */
export type I2cPhase =
  | { op: 'S'; addr: number; read: boolean }
  | { op: 'W'; byte: number }
  | { op: 'R'; ack: boolean }
  | { op: 'P' };

/**
 * An LEDC high-speed timer (patch 0009): running with a source clock, a 10.8 fixed-point divider
 * and a resolution (period = div / 256 * 2^res source clocks), held, or a configuration the
 * runtime refuses to represent.
 */
export type LedcTimerState =
  | { kind: 'run'; clockHz: number; div: number; res: number }
  | { kind: 'reset' }
  | { kind: 'paused' }
  | { kind: 'unsupported'; why: 'resolution' | 'divider' };

/** An LEDC channel's output (patch 0009): its idle level, or high for `duty` ticks from `hpoint`. */
export type LedcChannelState =
  | { kind: 'idle'; level: Level }
  | { kind: 'on'; timer: number; hpoint: number; duty: number }
  | { kind: 'unsupported'; why: 'low-speed' | 'interrupt' | 'dither' | 'fade' | 'hpoint' };

/** GPIO-matrix output signals of the LEDC channels: high speed 71..78, low speed 79..86. */
export const LEDC_SIGNALS = { first: 71, last: 86, highSpeedLast: 78 } as const;

export type Frame =
  | { type: 'H'; version: 1 | 2; tickNs: bigint; caps: Capability[] }
  | { type: 'G'; vns: bigint; pad: number; drive: Level; level: Level }
  | { type: 'T'; vns: bigint }
  | { type: 'S'; vns: bigint; bytes: Buffer }
  | { type: 'F'; vns: bigint; pad: number; func: PadFunction; openDrain: boolean }
  | { type: 'B'; vns: bigint; bus: 0 | 1; phase: I2cPhase }
  | { type: 'P'; vns: bigint; timer: number; state: LedcTimerState }
  | { type: 'W'; vns: bigint; signal: number; state: LedcChannelState };

export type Command =
  | { type: 'I'; pad: number; level: Level }
  | { type: 'R'; bytes: Buffer }
  | { type: 'Q' }
  /** Apply `level` to `pad` at virtual time `vns` (sched-input). */
  | { type: 'J'; vns: bigint; pad: number; level: Level }
  /** Cancel every pending scheduled input on `pad` (sched-input). */
  | { type: 'X'; pad: number }
  /** ACK (true) or NACK of an I2C START or written byte; only in a reply to `B S`/`B W`. */
  | { type: 'K'; ack: boolean }
  /** The byte the addressed target puts on the bus; only in a reply to `B R`. */
  | { type: 'D'; byte: number };

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export const PADS = 40;
/** Bytes per serial-input command line (the QEMU side accepts up to 4096 pending). */
const R_CHUNK = 256;
/** Pending scheduled inputs per process (QEMU's TBI_SCHED_MAX). */
export const SCHED_MAX = 512;
/** Minimum spacing of two scheduled inputs on the same pad, ns. */
export const SCHED_MIN_SPACING_NS = 1000n;

const hexByte = (s: string) => Number.parseInt(s, 16);
const hex2 = (n: number) => n.toString(16).padStart(2, '0');

function parseCaps(field: string, line: string): Capability[] {
  if (field === '-') return [];
  const caps = field.split(',');
  for (let i = 0; i < caps.length; i++) {
    if (!(CAPABILITIES as readonly string[]).includes(caps[i]!))
      throw new ProtocolError(`unknown bridge capability ${JSON.stringify(caps[i])}: ${line}`);
    if (i > 0 && caps[i - 1]! >= caps[i]!)
      throw new ProtocolError(`capabilities not sorted and unique: ${line}`);
  }
  return caps as Capability[];
}

function parsePadFunction(s: string, line: string): PadFunction {
  if (s === 'gpio' || /^i2c[01]-(scl|sda)$/.test(s)) return s as PadFunction;
  const m = /^periph:(0|[1-9]\d{0,2})$/.exec(s);
  if (m && Number(m[1]) < 256) return s as PadFunction;
  throw new ProtocolError(`invalid pad function: ${line}`);
}

function pad(s: string, line: string): number {
  const p = Number(s);
  if (p >= PADS) throw new ProtocolError(`pad out of range: ${line}`);
  return p;
}

/**
 * Parse one frame. The version is not checked here beyond 1|2 (the session checks it against the
 * handshake); every other field is.
 */
export function parseFrame(line: string): Frame {
  let m: RegExpExecArray | null;
  if ((m = /^H tbi-bridge (1|2) (\d+)(?: (\S+))?$/.exec(line))) {
    const version = Number(m[1]) as 1 | 2;
    if (version === 1 && m[3] !== undefined) throw new ProtocolError(`malformed v1 hello: ${line}`);
    if (version === 2 && m[3] === undefined)
      throw new ProtocolError(`v2 hello lacks caps: ${line}`);
    return {
      type: 'H',
      version,
      tickNs: BigInt(m[2]!),
      caps: version === 2 ? parseCaps(m[3]!, line) : [],
    };
  }
  if (/^H tbi-bridge \d+ /.test(line))
    throw new ProtocolError(`unsupported bridge protocol: ${line}`);
  if ((m = /^G (\d+) (\d+) ([01]) ([01])$/.exec(line))) {
    return {
      type: 'G',
      vns: BigInt(m[1]!),
      pad: pad(m[2]!, line),
      drive: Number(m[3]) as Level,
      level: Number(m[4]) as Level,
    };
  }
  if ((m = /^T (\d+)$/.exec(line))) return { type: 'T', vns: BigInt(m[1]!) };
  if ((m = /^S (\d+) ((?:[0-9a-f]{2})+)$/.exec(line))) {
    return { type: 'S', vns: BigInt(m[1]!), bytes: Buffer.from(m[2]!, 'hex') };
  }
  if ((m = /^F (\d+) (\d+) (\S+) ([01])$/.exec(line))) {
    return {
      type: 'F',
      vns: BigInt(m[1]!),
      pad: pad(m[2]!, line),
      func: parsePadFunction(m[3]!, line),
      openDrain: m[4] === '1',
    };
  }
  if ((m = /^B (\d+) ([01]) (.*)$/.exec(line))) {
    const rest = m[3]!;
    let p: RegExpExecArray | null;
    let phase: I2cPhase;
    if ((p = /^S ([0-7][0-9a-f]) ([01])$/.exec(rest)))
      phase = { op: 'S', addr: hexByte(p[1]!), read: p[2] === '1' };
    else if ((p = /^W ([0-9a-f]{2})$/.exec(rest))) phase = { op: 'W', byte: hexByte(p[1]!) };
    else if ((p = /^R ([01])$/.exec(rest))) phase = { op: 'R', ack: p[1] === '1' };
    else if (rest === 'P') phase = { op: 'P' };
    else throw new ProtocolError(`malformed i2c frame: ${JSON.stringify(line.slice(0, 80))}`);
    return { type: 'B', vns: BigInt(m[1]!), bus: Number(m[2]) as 0 | 1, phase };
  }
  if ((m = /^P (\d+) ([0-3]) (.*)$/.exec(line))) {
    const rest = m[3]!;
    let p: RegExpExecArray | null;
    let state: LedcTimerState;
    if ((p = /^run (1000000|[1-9]\d{6,7}) ([1-9]\d{2,5}) ([1-9]|1\d|20)$/.exec(rest))) {
      const div = Number(p[2]);
      if (div < 256 || div > 0x3ffff) throw new ProtocolError(`LEDC divider out of range: ${line}`);
      state = { kind: 'run', clockHz: Number(p[1]), div, res: Number(p[3]) };
    } else if (rest === 'reset' || rest === 'paused') state = { kind: rest };
    else if ((p = /^unsupported (resolution|divider)$/.exec(rest)))
      state = { kind: 'unsupported', why: p[1] as 'resolution' | 'divider' };
    else
      throw new ProtocolError(`malformed LEDC timer frame: ${JSON.stringify(line.slice(0, 80))}`);
    return { type: 'P', vns: BigInt(m[1]!), timer: Number(m[2]), state };
  }
  if ((m = /^W (\d+) (7[1-9]|8[0-6]) (.*)$/.exec(line))) {
    const rest = m[3]!;
    let p: RegExpExecArray | null;
    let state: LedcChannelState;
    if ((p = /^idle ([01])$/.exec(rest))) state = { kind: 'idle', level: Number(p[1]) as Level };
    else if ((p = /^on ([0-3]) (0|[1-9]\d{0,6}) (0|[1-9]\d{0,6})$/.exec(rest))) {
      const hpoint = Number(p[2]);
      const duty = Number(p[3]);
      if (hpoint >= 1 << 20 || duty > 1 << 20)
        throw new ProtocolError(`LEDC channel value out of range: ${line}`);
      state = { kind: 'on', timer: Number(p[1]), hpoint, duty };
    } else if ((p = /^unsupported (low-speed|interrupt|dither|fade|hpoint)$/.exec(rest)))
      state = { kind: 'unsupported', why: p[1] as 'low-speed' };
    else
      throw new ProtocolError(`malformed LEDC channel frame: ${JSON.stringify(line.slice(0, 80))}`);
    return { type: 'W', vns: BigInt(m[1]!), signal: Number(m[2]), state };
  }
  throw new ProtocolError(`malformed frame: ${JSON.stringify(line.slice(0, 80))}`);
}

/** What the reply answers: the frame and the capabilities negotiated at `H`. */
export interface ReplyContext {
  frame: Exclude<Frame, { type: 'S' }>;
  caps: readonly Capability[];
}

const frameVns = (f: ReplyContext['frame']) => (f.type === 'H' ? 0n : f.vns);

/**
 * The reply to a frame: commands, then `C`. With a context (every session reply), each command is
 * checked against what QEMU accepts for that frame; anything else is a host bug and throws.
 */
export function encodeReply(commands: readonly Command[], ctx?: ReplyContext): string {
  let out = '';
  let busReplies = 0;
  const need = (cap: Capability, what: string) => {
    if (ctx && !ctx.caps.includes(cap))
      throw new ProtocolError(`${what} needs runtime capability ${cap}`);
  };
  for (const c of commands) {
    if (c.type === 'I' || c.type === 'J' || c.type === 'X') {
      if (!Number.isInteger(c.pad) || c.pad < 0 || c.pad >= PADS) {
        throw new ProtocolError(`${c.type} command for invalid pad ${c.pad}`);
      }
    }
    if (c.type === 'I') {
      out += `I ${c.pad} ${c.level}\n`;
    } else if (c.type === 'R') {
      if (ctx && ctx.frame.type !== 'T') throw new ProtocolError('serial input outside a tick');
      for (let i = 0; i < c.bytes.length; i += R_CHUNK) {
        out += `R ${c.bytes.subarray(i, i + R_CHUNK).toString('hex')}\n`;
      }
    } else if (c.type === 'J') {
      need('sched-input', 'J');
      if (c.level !== 0 && c.level !== 1) throw new ProtocolError(`J level ${String(c.level)}`);
      if (ctx && c.vns <= frameVns(ctx.frame))
        throw new ProtocolError(`J at ${c.vns} is not after the frame at ${frameVns(ctx.frame)}`);
      out += `J ${c.vns} ${c.pad} ${c.level}\n`;
    } else if (c.type === 'X') {
      need('sched-input', 'X');
      out += `X ${c.pad}\n`;
    } else if (c.type === 'K' || c.type === 'D') {
      need('i2c', c.type);
      const f = ctx?.frame;
      if (ctx && f?.type !== 'B') throw new ProtocolError(`${c.type} outside an i2c reply`);
      if (f?.type === 'B') {
        const want = f.phase.op === 'R' ? 'D' : f.phase.op === 'P' ? null : 'K';
        if (want !== c.type) throw new ProtocolError(`${c.type} in reply to B ${f.phase.op}`);
      }
      if (c.type === 'D') {
        if (!Number.isInteger(c.byte) || c.byte < 0 || c.byte > 0xff)
          throw new ProtocolError(`D byte ${c.byte}`);
        out += `D ${hex2(c.byte)}\n`;
      } else out += `K ${c.ack ? 1 : 0}\n`;
      busReplies++;
    } else {
      out += 'Q\n';
    }
  }
  if (ctx?.frame.type === 'B') {
    const want = ctx.frame.phase.op === 'P' ? 0 : 1;
    if (busReplies !== want)
      throw new ProtocolError(`B ${ctx.frame.phase.op} reply needs ${want} K/D, got ${busReplies}`);
  }
  return `${out}C\n`;
}

/**
 * The host's mirror of QEMU's scheduled-input queue (ADR-011 §2): the same limits, enforced first.
 * An entry counts as pending until a frame strictly later than it is seen, so the host's count is
 * never below QEMU's: whatever passes here, QEMU accepts.
 */
export class InputSchedule {
  private pending: { vns: bigint; pad: number }[] = [];

  /** Forget entries QEMU has certainly applied (a frame at `vns` was seen). */
  advance(vns: bigint): void {
    this.pending = this.pending.filter((e) => e.vns >= vns);
  }

  get size(): number {
    return this.pending.length;
  }

  /** Why `J` cannot be queued now, or null. Does not change the schedule. */
  problem(vns: bigint, pad: number): 'full' | 'spacing' | null {
    if (this.pending.length >= SCHED_MAX) return 'full';
    for (const e of this.pending) {
      if (e.pad !== pad) continue;
      const d = e.vns > vns ? e.vns - vns : vns - e.vns;
      if (d < SCHED_MIN_SPACING_NS) return 'spacing';
    }
    return null;
  }

  add(vns: bigint, pad: number): void {
    const p = this.problem(vns, pad);
    if (p) throw new ProtocolError(`scheduled input rejected (${p}) at ${vns} on pad ${pad}`);
    this.pending.push({ vns, pad });
  }

  cancel(pad: number): void {
    this.pending = this.pending.filter((e) => e.pad !== pad);
  }

  pendingOn(pad: number): bigint[] {
    return this.pending.filter((e) => e.pad === pad).map((e) => e.vns);
  }
}

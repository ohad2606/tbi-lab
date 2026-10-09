/**
 * Sprint 12 (ADR-011): bridge v2 on the host side. The strict parser and encoder (T-PROTO-1..6),
 * the host's mirror of QEMU's scheduled-input limits, and capability binding at the handshake
 * through the whole Session Host with the fake runtime (T-PROTO-7/8). No QEMU.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  encodeReply,
  InputSchedule,
  parseFrame,
  ProtocolError,
  SCHED_MAX,
  type Capability,
  type Command,
  type Frame,
  type ReplyContext,
} from '../../harness/protocol.js';
import type { TicketFeatures } from '../../identity/ticket.js';
import { principalFor, ticketFor } from '../../identity/test-gate.js';
import type { SessionHost } from '../host.js';
import type { HostSession } from '../session.js';
import { createRequest, fakeHost, serialText, waitState } from './support.js';

const ALL: Capability[] = ['i2c', 'pad-func', 'sched-input'];
const bad = (line: string) => expect(() => parseFrame(line), line).toThrow(ProtocolError);
const ctx = (line: string, caps: Capability[] = ALL): ReplyContext => ({
  frame: parseFrame(line) as ReplyContext['frame'],
  caps,
});
const refused = (cmds: Command[], c: ReplyContext) =>
  expect(() => encodeReply(cmds, c)).toThrow(ProtocolError);

describe('T-PROTO-1..3: handshake and capabilities', () => {
  it('parses v2 with sorted known tokens and with none', () => {
    expect(parseFrame('H tbi-bridge 2 1000000 i2c,pad-func,sched-input')).toEqual({
      type: 'H',
      version: 2,
      tickNs: 1_000_000n,
      caps: ['i2c', 'pad-func', 'sched-input'],
    });
    expect(parseFrame('H tbi-bridge 2 1000000 sched-input')).toMatchObject({
      caps: ['sched-input'],
    });
    expect(parseFrame('H tbi-bridge 2 1000000 -')).toMatchObject({ version: 2, caps: [] });
  });

  it('v1 is accepted with an empty capability set', () => {
    expect(parseFrame('H tbi-bridge 1 1000000')).toEqual({
      type: 'H',
      version: 1,
      tickNs: 1_000_000n,
      caps: [],
    });
  });

  it('fails closed on other versions, unknown, unsorted or duplicate tokens', () => {
    bad('H tbi-bridge 3 1000000 -');
    bad('H tbi-bridge 0 1000000');
    bad('H tbi-bridge 1 1000000 i2c'); // v1 carries no capabilities
    bad('H tbi-bridge 2 1000000'); // v2 must state them, `-` for none
    bad('H tbi-bridge 2 1000000 i2c,ledc');
    bad('H tbi-bridge 2 1000000 sched-input,i2c');
    bad('H tbi-bridge 2 1000000 i2c,i2c');
    bad('H tbi-bridge 2 1000000 I2C');
    bad('H tbi-bridge 2 1000000 i2c,');
  });
});

describe('T-PROTO-4: F and B frames', () => {
  it('parses every valid form', () => {
    expect(parseFrame('F 890260872 21 i2c0-sda 1')).toEqual({
      type: 'F',
      vns: 890260872n,
      pad: 21,
      func: 'i2c0-sda',
      openDrain: true,
    });
    expect(parseFrame('F 5 22 gpio 0')).toMatchObject({ func: 'gpio', openDrain: false });
    expect(parseFrame('F 5 4 periph:255 0')).toMatchObject({ func: 'periph:255' });
    expect(parseFrame('B 7 0 S 27 0')).toEqual({
      type: 'B',
      vns: 7n,
      bus: 0,
      phase: { op: 'S', addr: 0x27, read: false },
    });
    expect(parseFrame('B 7 1 S 7f 1')).toMatchObject({ bus: 1, phase: { addr: 0x7f, read: true } });
    expect(parseFrame('B 7 0 W ee')).toMatchObject({ phase: { op: 'W', byte: 0xee } });
    expect(parseFrame('B 7 0 R 0')).toMatchObject({ phase: { op: 'R', ack: false } });
    expect(parseFrame('B 7 0 P')).toMatchObject({ phase: { op: 'P' } });
  });

  it('refuses every malformed variant', () => {
    bad('F 5 40 gpio 0'); // pad >= 40
    bad('F 5 4 uart0-tx 0'); // unknown function
    bad('F 5 4 periph:256 0');
    bad('F 5 4 periph:01 0');
    bad('F 5 4 i2c2-sda 1');
    bad('F 5 4 gpio 2');
    bad('B 7 2 P'); // bus 2
    bad('B 7 0 S 80 0'); // address > 0x7f
    bad('B 7 0 S 27'); // missing r/w
    bad('B 7 0 W 100'); // byte > 0xff
    bad('B 7 0 W EE'); // uppercase hex
    bad('B 7 0 R 2');
    bad('B 7 0 P 1');
    bad('B 7 0 X');
    bad('B -1 0 P');
  });
});

describe('T-PROTO-5/6: the encoder never emits what QEMU would reject', () => {
  it('J must be later than the frame, on a valid pad and level, with sched-input', () => {
    const t = ctx('T 1000000');
    expect(encodeReply([{ type: 'J', vns: 1_000_001n, pad: 4, level: 1 }], t)).toBe(
      'J 1000001 4 1\nC\n',
    );
    refused([{ type: 'J', vns: 1_000_000n, pad: 4, level: 1 }], t);
    refused([{ type: 'J', vns: 999_999n, pad: 4, level: 1 }], t);
    refused([{ type: 'J', vns: 2_000_000n, pad: 40, level: 1 }], t);
    refused([{ type: 'J', vns: 2_000_000n, pad: 4, level: 2 as 0 }], t);
    refused([{ type: 'J', vns: 2_000_000n, pad: 4, level: 1 }], ctx('T 1000000', ['i2c']));
    refused([{ type: 'X', pad: 4 }], ctx('T 1000000', []));
    // In the handshake reply the frame time is 0.
    expect(
      encodeReply(
        [{ type: 'J', vns: 1n, pad: 4, level: 0 }],
        ctx('H tbi-bridge 2 1000 sched-input'),
      ),
    ).toBe('J 1 4 0\nC\n');
  });

  it('K and D only, and exactly once, in replies to B', () => {
    const k = { type: 'K', ack: true } as const;
    const d = { type: 'D', byte: 0x5a } as const;
    expect(encodeReply([k], ctx('B 9 0 S 27 0'))).toBe('K 1\nC\n');
    expect(encodeReply([{ type: 'K', ack: false }], ctx('B 9 0 W 08'))).toBe('K 0\nC\n');
    expect(encodeReply([d], ctx('B 9 0 R 1'))).toBe('D 5a\nC\n');
    expect(encodeReply([], ctx('B 9 0 P'))).toBe('C\n');
    refused([], ctx('B 9 0 S 27 0')); // missing
    refused([k, k], ctx('B 9 0 W 08')); // twice
    refused([d], ctx('B 9 0 S 27 0')); // wrong kind
    refused([k], ctx('B 9 0 R 1'));
    refused([k], ctx('B 9 0 P'));
    refused([k], ctx('T 1000')); // outside a B reply
    refused([d], ctx('G 9 4 1 1'));
    refused([{ type: 'D', byte: 256 }], ctx('B 9 0 R 1'));
    refused([k], ctx('B 9 0 S 27 0', ['sched-input']));
  });

  it('serial input only in tick replies', () => {
    refused([{ type: 'R', bytes: Buffer.from('a') }], ctx('G 9 4 1 1'));
    expect(encodeReply([{ type: 'R', bytes: Buffer.from('a') }], ctx('T 1000'))).toBe('R 61\nC\n');
  });

  it('v1 replies are unchanged', () => {
    const f: Frame = parseFrame('G 9 4 1 1');
    expect(
      encodeReply([{ type: 'I', pad: 5, level: 1 }, { type: 'Q' }], {
        frame: f as ReplyContext['frame'],
        caps: [],
      }),
    ).toBe('I 5 1\nQ\nC\n');
  });
});

describe('scheduled-input limits (host mirror of TBI_SCHED_MAX and the 1 µs spacing)', () => {
  it('refuses spacing below 1 µs on one pad, not across pads', () => {
    const s = new InputSchedule();
    s.add(10_000n, 4);
    expect(s.problem(10_999n, 4)).toBe('spacing');
    expect(s.problem(9_001n, 4)).toBe('spacing');
    expect(s.problem(11_000n, 4)).toBeNull();
    expect(s.problem(10_000n, 5)).toBeNull();
    expect(() => s.add(10_500n, 4)).toThrow(ProtocolError);
  });

  it('caps pending entries at 512 and forgets entries a later frame proves applied', () => {
    const s = new InputSchedule();
    for (let i = 0; i < SCHED_MAX; i++) s.add(BigInt(i) * 1000n + 1000n, i % 40);
    expect(s.problem(10_000_000n, 0)).toBe('full');
    s.advance(1000n); // the entry AT 1000 may not have been applied yet: still counted
    expect(s.size).toBe(SCHED_MAX);
    s.advance(1001n);
    expect(s.size).toBe(SCHED_MAX - 1);
    s.cancel(3);
    expect(s.pendingOn(3)).toEqual([]);
  });
});

// ---- T-PROTO-7/8 through the Session Host ------------------------------------------------------

const hosts: SessionHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.shutdown()));
});

function session(env: Record<string, string>, features: TicketFeatures | null) {
  const r = fakeHost('normal', {
    runtimeEnv: { PATH: process.env.PATH, TBI_FAKE_MODE: 'normal', ...env },
  });
  hosts.push(r.host);
  const req = createRequest(r.art.sha256, {
    ticket: ticketFor(r.art.sha256, principalFor(), features),
  });
  const c = r.host.create(req, principalFor());
  if (!c.ok) throw new Error(c.error);
  return c.value.session;
}
const features = (requires?: string[]): TicketFeatures => ({
  internalPull: [],
  gpioInterrupt: [],
  restart: false,
  unsupported: [],
  ...(requires ? { requires } : {}),
});
const terminal = async (s: HostSession) => {
  await Promise.race([waitState(s, 'failed', 15_000), waitState(s, 'ended', 15_000)]);
  await s.done();
  return s.status();
};
const runFor = async (s: HostSession, ms: number) => {
  s.run();
  await waitState(s, 'running');
  await new Promise((r) => setTimeout(r, ms));
  s.stop();
  return terminal(s);
};

describe('T-PROTO-7/8: capabilities are bound to the session at the handshake', () => {
  it('a ticket requiring i2c on a runtime without it fails before the firmware runs', async () => {
    const s = session({ TBI_FAKE_HELLO: '2 sched-input' }, features(['i2c']));
    s.run();
    const st = await terminal(s);
    expect(st).toMatchObject({
      state: 'failed',
      reason: 'unsupported_feature',
      detail: { requires: ['i2c'], runtimeCapabilities: ['sched-input'] },
    });
    // Quit inside the handshake reply: no tick was ever answered.
    expect(BigInt(st.simNs)).toBe(0n);
  });

  it('the same ticket on a v1 runtime (no capabilities) fails the same way', async () => {
    const s = session({ TBI_FAKE_HELLO: '1' }, features(['i2c']));
    s.run();
    expect(await terminal(s)).toMatchObject({
      reason: 'unsupported_feature',
      detail: { requires: ['i2c'], runtimeCapabilities: [] },
    });
  });

  it('a ticket whose requirements are announced runs', async () => {
    const s = session({ TBI_FAKE_HELLO: '2 i2c,pad-func,sched-input' }, features(['i2c']));
    expect(await runFor(s, 300)).toMatchObject({ state: 'ended', reason: 'stopped' });
    expect(serialText(s)).toContain('BOOT 1');
  });

  it('T-PROTO-8: a ticket without `requires` behaves as in Sprint 11, on v1 and v2', async () => {
    for (const hello of ['1', '2 -', '2 i2c,pad-func,sched-input']) {
      const s = session({ TBI_FAKE_HELLO: hello }, features());
      expect(await runFor(s, 200), hello).toMatchObject({ state: 'ended', reason: 'stopped' });
    }
  });

  it('an unknown capability or protocol version from the runtime fails closed', async () => {
    for (const hello of ['2 i2c,ledc', '3 -']) {
      const s = session({ TBI_FAKE_HELLO: hello }, null);
      s.run();
      expect(await terminal(s), hello).toMatchObject({
        state: 'failed',
        reason: 'host_protocol_error',
      });
    }
  });

  it('an F or B frame from a runtime that did not announce its capability fails closed', async () => {
    for (const fr of ['F 9500000 21 i2c0-sda 1', 'B 9500000 0 S 27 0']) {
      const s = session({ TBI_FAKE_HELLO: '2 sched-input', TBI_FAKE_FRAMES: fr }, null);
      s.run();
      expect(await terminal(s), fr).toMatchObject({ reason: 'host_protocol_error' });
    }
  });

  it('a B phase with no I2C model attached is NACKed / reads the released bus', async () => {
    const frames = ['B 9500000 0 S 27 0', 'B 9500001 0 W 08', 'B 9500002 0 R 0', 'B 9500003 0 P'];
    const s = session(
      { TBI_FAKE_HELLO: '2 i2c,pad-func,sched-input', TBI_FAKE_FRAMES: frames.join(';') },
      null,
    );
    expect(await runFor(s, 300)).toMatchObject({ state: 'ended' });
    const text = serialText(s);
    expect(text).toContain('REPLY B 9500000 0 S 27 0 -> K 0');
    expect(text).toContain('REPLY B 9500001 0 W 08 -> K 0');
    expect(text).toContain('REPLY B 9500002 0 R 0 -> D ff');
    expect(text).toContain('REPLY B 9500003 0 P -> \n');
  });
});

describe('pad functions (patch 0007, ADR-011 §3)', () => {
  const caps = '2 i2c,pad-func,sched-input';
  it('another peripheral on a circuit pad, still routed at the next tick, refuses the session', async () => {
    const s = session({ TBI_FAKE_HELLO: caps, TBI_FAKE_FRAMES: 'F 9500000 18 periph:14 0' }, null);
    s.run();
    expect(await terminal(s)).toMatchObject({
      state: 'failed',
      reason: 'unsupported_feature',
      detail: { gpio: 18, function: 'periph:14', since: '9500000' },
    });
  });

  it('a transient routing undone before the next tick (pinMode INPUT) is not a feature', async () => {
    const s = session(
      { TBI_FAKE_HELLO: caps, TBI_FAKE_FRAMES: 'F 9500000 18 periph:0 0;F 9500056 18 gpio 0' },
      null,
    );
    expect(await runFor(s, 300)).toMatchObject({ state: 'ended', reason: 'stopped' });
  });

  it('peripheral routing on pads outside the circuit (flash, UART) is ignored', async () => {
    const s = session(
      { TBI_FAKE_HELLO: caps, TBI_FAKE_FRAMES: 'F 9500000 7 periph:1 0;F 9500001 1 periph:14 0' },
      null,
    );
    expect(await runFor(s, 300)).toMatchObject({ state: 'ended', reason: 'stopped' });
  });

  it('an I2C function releases the pad (open drain idle) and the session runs on', async () => {
    const s = session({ TBI_FAKE_HELLO: caps, TBI_FAKE_FRAMES: 'F 9500000 18 i2c0-scl 1' }, null);
    expect(await runFor(s, 300)).toMatchObject({ state: 'ended', reason: 'stopped' });
    expect(serialText(s)).toContain('REPLY F 9500000 18 i2c0-scl 1 ->');
  });
});

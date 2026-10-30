/**
 * Sprint 25 (Runtime v5, `input-read`): the host marks the pads the program may read whose level
 * is undefined (`Z`), and a read of one (`N`) ends the session at its virtual time, naming the pads
 * and why. The strict parser and encoder, then the whole Session Host with the fake runtime. No QEMU.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  encodeReply,
  parseFrame,
  ProtocolError,
  type ReplyContext,
} from '../../harness/protocol.js';
import type { TicketFeatures } from '../../identity/ticket.js';
import { principalFor, ticketFor } from '../../identity/test-gate.js';
import type { SessionHost } from '../host.js';
import type { HostSession } from '../session.js';
import { createRequest, fakeHost, waitState } from './support.js';

const V5 = '2 gpio-irq,i2c,input-read,pad-func,pwm,sched-input,unmodelled';
const bad = (line: string) => expect(() => parseFrame(line), line).toThrow(ProtocolError);

describe('input-read frames', () => {
  it('parses N with a 40-bit pad mask into ascending pads', () => {
    expect(parseFrame('N 42 0000000020')).toEqual({ type: 'N', vns: 42n, pads: [5] });
    expect(parseFrame('N 42 8000800004')).toEqual({ type: 'N', vns: 42n, pads: [2, 23, 39] });
    // No pad, a pad beyond GPIO39, a short or upper-case mask, a missing time: protocol errors.
    for (const l of [
      'N 42 0000000000',
      'N 42 10000000000',
      'N 42 20',
      'N 42 00000000A0',
      'N 0000000020',
    ])
      bad(l);
  });

  it('Z is encoded only on a runtime announcing input-read, for a valid pad', () => {
    const ctx = (caps: ReplyContext['caps']): ReplyContext => ({
      frame: parseFrame('T 1000000') as ReplyContext['frame'],
      caps,
    });
    expect(encodeReply([{ type: 'Z', pad: 5, undefined: true }], ctx(['input-read']))).toBe(
      'Z 5 1\nC\n',
    );
    expect(encodeReply([{ type: 'Z', pad: 39, undefined: false }], ctx(['input-read']))).toBe(
      'Z 39 0\nC\n',
    );
    expect(() => encodeReply([{ type: 'Z', pad: 5, undefined: true }], ctx(['i2c']))).toThrow(
      ProtocolError,
    );
    expect(() =>
      encodeReply([{ type: 'Z', pad: 40, undefined: true }], ctx(['input-read'])),
    ).toThrow(ProtocolError);
  });
});

// ---- through the Session Host -----------------------------------------------------------------

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
const reads = (pins: number[], unresolved = false): TicketFeatures => ({
  internalPull: [],
  gpioInterrupt: [],
  restart: false,
  unsupported: [],
  requires: ['input-read'],
  inputReads: { pins, unresolved },
});
const terminal = async (s: HostSession) => {
  await Promise.race([waitState(s, 'failed', 15_000), waitState(s, 'ended', 15_000)]);
  await s.done();
  return s.status();
};
const replies = (s: HostSession) =>
  s.log
    .since(0)
    .filter((e) => e.type === 'serial')
    .map((e) => Buffer.from((e as { data: string }).data, 'base64').toString())
    .join('')
    .split('\n')
    .filter((l) => l.startsWith('REPLY '));

describe('the Session Host refuses a read of an undefined input (fake runtime)', () => {
  // The bench (support.ts): GPIO2 -> 220 ohm -> LED -> GND (nothing holds it while it is an input),
  // GPIO5 -> 1 kohm -> 10 kohm -> GND (held at 0 V), GPIO18 -> 1 kohm -> GND. GPIO23 is not wired.

  it('a read of a pin the program reads with nothing wired to it: unconnected, at the read', async () => {
    const s = session(
      { TBI_FAKE_HELLO: V5, TBI_FAKE_FRAMES: 'N 9500000 0000800000' },
      reads([5, 23]),
    );
    s.run();
    expect(await terminal(s)).toMatchObject({
      state: 'failed',
      reason: 'electrical_error',
      detail: {
        code: 'gpio_input_undefined',
        param: 'gpio23',
        detail: { inputs: [{ gpio: 23, cause: 'unconnected' }], sinceNs: '9500000' },
      },
    });
  });

  it('a floating wired pin is marked undefined while it is an input, and defined once driven', async () => {
    // GPIO2 floats until the fake firmware drives it (first at 5 ms); a read at 1.5 ms is refused.
    const s = session(
      { TBI_FAKE_HELLO: V5, TBI_FAKE_FRAMES: '2@N 1500000 0000000004' },
      reads([2, 5]),
    );
    s.run();
    expect(await terminal(s)).toMatchObject({
      reason: 'electrical_error',
      detail: {
        code: 'gpio_input_undefined',
        detail: { inputs: [{ gpio: 2, cause: 'floating' }], sinceNs: '1500000' },
      },
    });
  });

  it('a held pin is never marked; marks follow the program’s reads only', async () => {
    // GPIO5 is held by its pull-down; GPIO2 floats but the program does not read it: nothing is
    // undefined, so a frame naming them could only come from a runtime bug (still refused).
    const s = session({ TBI_FAKE_HELLO: V5, TBI_FAKE_FRAMES: '20@T 19500000' }, reads([5]));
    s.run();
    await waitState(s, 'running');
    await new Promise((r) => setTimeout(r, 400));
    s.stop();
    expect(await terminal(s)).toMatchObject({ state: 'ended', reason: 'stopped' });
    // The reply to the extra frame carried no Z: GPIO5 was never undefined.
    expect(replies(s).join('\n')).not.toMatch(/Z /);
  });

  it('an unresolved read watches every wired pad', async () => {
    const s = session(
      { TBI_FAKE_HELLO: V5, TBI_FAKE_FRAMES: '2@N 1500000 0000000004' },
      reads([], true),
    );
    s.run();
    expect(await terminal(s)).toMatchObject({
      detail: {
        code: 'gpio_input_undefined',
        detail: { inputs: [{ gpio: 2, cause: 'floating' }] },
      },
    });
  });

  it('firmware that was not analysed (no ticket record) watches every wired pad too', async () => {
    const s = session({ TBI_FAKE_HELLO: V5, TBI_FAKE_FRAMES: '2@N 1500000 0000000004' }, null);
    s.run();
    expect(await terminal(s)).toMatchObject({
      detail: {
        code: 'gpio_input_undefined',
        detail: { inputs: [{ gpio: 2, cause: 'floating' }] },
      },
    });
  });

  it('an N frame from a runtime without input-read fails closed (protocol error)', async () => {
    const s = session(
      {
        TBI_FAKE_HELLO: '2 i2c,pad-func,sched-input,unmodelled',
        TBI_FAKE_FRAMES: 'N 9500000 0000000020',
      },
      null,
    );
    s.run();
    expect(await terminal(s)).toMatchObject({ reason: 'host_protocol_error' });
  });

  it('a program that reads inputs needs input-read: refused at the handshake on Runtime v4', async () => {
    const s = session({ TBI_FAKE_HELLO: '2 i2c,pad-func,pwm,sched-input,unmodelled' }, reads([5]));
    s.run();
    expect(await terminal(s)).toMatchObject({
      reason: 'unsupported_feature',
      detail: { requires: ['input-read'] },
    });
  });
});

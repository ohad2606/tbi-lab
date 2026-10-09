#!/usr/bin/env node
/**
 * A stand-in for qemu-system-xtensa that speaks the real TBI bridge protocol (R1 tbi_bridge.c),
 * so routine CI can exercise the whole Session Host without the heavyweight runtime.
 *
 * Emulated "firmware" (TBI_FAKE_MODE=normal):
 *   - boot: reads a boot counter from its PRIVATE flash copy (offset 0x9000), increments it,
 *     writes it back (a guest flash write), prints `BOOT n` on UART0;
 *   - GPIO2 toggles every 5 ms of simulation time, at a time OFF the 1 ms tick grid;
 *   - GPIO18 follows the injected level of GPIO5 immediately (at the same simulation time + 8 ns);
 *   - prints `IN5=<level>` whenever GPIO5's injected level changes.
 * Failure modes: no_hello, crash, stall, garbage, guest_reset, serial_flood, ignore_term,
 * time_backwards; drive_input_only (drives input-only GPIO34 HIGH at 20 ms).
 * Bridge v2 (Sprint 12, ADR-011): TBI_FAKE_HELLO replaces the handshake line's version and
 * capability fields (e.g. `2 i2c,pad-func,sched-input`, `2 -`, `3 -`); TBI_FAKE_FRAMES is a list
 * of extra frames, `;`-separated, sent before the tick at 10 ms, or before tick n with an `n@`
 * prefix (e.g. `B 9500000 0 S 27 0`, `1300@G 1299000100 4 1 0`); every reply to them is echoed on
 * UART0 as `REPLY <frame> -> <commands>`.
 */
import { connect } from 'node:net';
import { openSync, readSync, writeSync, closeSync } from 'node:fs';

const mode = process.env.TBI_FAKE_MODE ?? 'normal';
const arg = (prefix) => process.argv.find((a) => a.startsWith(prefix));
const device = arg('tbi-bridge,');
// Sprint 8: the bridge is a unix socket path (no network).
const [, path, tickUs] = /syncpath=([^,]+),tick-us=(\d+)/.exec(device);
const flash = /file=([^,]+)/.exec(arg('file='))[1];
const tick = BigInt(tickUs) * 1000n;

if (mode === 'ignore_term') process.on('SIGTERM', () => {});

const sock = connect(path);
sock.setNoDelay(true);
let buf = '';
let waiting = null; // resolve of the pending reply
sock.on('data', (d) => {
  buf += d.toString('latin1');
  let nl;
  while (waiting && (nl = buf.indexOf('C\n')) >= 0) {
    const reply = buf.slice(0, nl);
    buf = buf.slice(nl + 2);
    const w = waiting;
    waiting = null;
    w(reply.split('\n').filter(Boolean));
  }
});
sock.on('close', () => process.exit(4));
sock.on('error', () => process.exit(4));

const exchange = (line) =>
  new Promise((resolve) => {
    waiting = resolve;
    sock.write(`${line}\n`);
  });
const serial = (vns, text) => sock.write(`S ${vns} ${Buffer.from(text).toString('hex')}\n`);

let vns = 0n;
const inputs = new Map();
let quit = false;
const out = new Map();

async function apply(cmds) {
  for (const c of cmds) {
    if (c === 'Q') quit = true;
    const m = /^I (\d+) ([01])$/.exec(c);
    if (m) {
      const pad = Number(m[1]);
      const level = Number(m[2]);
      if (inputs.get(pad) === level) continue;
      inputs.set(pad, level);
      if (pad === 5) {
        serial(vns, `IN5=${level}\n`);
        await setPad(18, 1, level, vns + 8n);
      }
    }
  }
}

async function setPad(pad, drive, level, at) {
  const key = `${drive}${level}`;
  if (out.get(pad) === key) return;
  out.set(pad, key);
  await apply(await exchange(`G ${at} ${pad} ${drive} ${level}`));
}

function bootCounter() {
  const fd = openSync(flash, 'r+');
  const b = Buffer.alloc(1);
  readSync(fd, b, 0, 1, 0x9000);
  const n = b[0] === 0xff ? 1 : b[0] + 1;
  writeSync(fd, Buffer.from([n]), 0, 1, 0x9000); // a guest flash write, into the private copy
  closeSync(fd);
  return n;
}

async function main() {
  await new Promise((r) => sock.on('connect', r));
  if (mode === 'no_hello') return new Promise(() => {});
  const [ver, caps] = (process.env.TBI_FAKE_HELLO ?? '1').split(' ');
  const hello = await exchange(`H tbi-bridge ${ver} ${tick}${caps ? ` ${caps}` : ''}`);
  const extra = (process.env.TBI_FAKE_FRAMES ?? '').split(';').filter(Boolean);
  // Boot first (at time 0), then act on the initial input levels the host injected.
  serial(0n, `BOOT ${bootCounter()}\n`);
  await apply(hello);
  let level = 0;
  for (let n = 1; !quit; n++) {
    vns = BigInt(n) * tick;
    // GPIO2: toggles every 5 ms, 1234 ns after the tick (never on the command grid).
    if (vns % 5_000_000n === 0n) {
      level ^= 1;
      await setPad(2, 1, level, vns - tick + 1234n);
    }
    if (mode === 'drive_input_only' && n === 20) await setPad(34, 1, 1, vns - 500n);
    for (const entry of extra) {
      const [at, fr] = entry.includes('@') ? entry.split('@') : ['10', entry];
      if (Number(at) !== n) continue;
      const r = await exchange(fr);
      serial(BigInt(fr.split(' ')[1]), `REPLY ${fr} -> ${r.join('|')}\n`);
      await apply(r);
    }
    if (mode === 'serial_flood') serial(vns, 'x'.repeat(200));
    if (mode === 'garbage' && n === 20) sock.write('Z this is not a frame\n');
    if (mode === 'time_backwards' && n === 20) {
      await exchange(`T ${vns - 5n * tick}`);
      continue;
    }
    if (mode === 'crash' && n === 30) process.kill(process.pid, 'SIGSEGV');
    if (mode === 'guest_reset' && n === 30) process.exit(0);
    if (mode === 'stall' && n === 30) return new Promise(() => {});
    await apply(await exchange(`T ${vns}`));
    if (n % 256 === 0) await new Promise((r) => setImmediate(r)); // stay a polite process
  }
  sock.end();
  process.exit(0);
}
main().catch(() => process.exit(1));

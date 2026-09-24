#!/usr/bin/env node
/**
 * Stand-in for qemu-system-xtensa in failure-mode tests: speaks the bridge protocol and then
 * misbehaves in a chosen way (TBI_FAKE_QEMU_MODE), so host-side protocol validation can be tested
 * without relying on a real emulator to produce corrupt frames.
 */
import { connect } from 'node:net';

const arg = process.argv.find((a) => a.startsWith('tbi-bridge,'));
const [host, port] = /syncport=([^,]+)/.exec(arg)[1].split(':');
const mode = process.env.TBI_FAKE_QEMU_MODE;
const s = connect(Number(port), host);
const script = {
  malformed_frame: ['H tbi-bridge 1 1000000', 'G 5 99 1 1'],
  time_backwards: ['H tbi-bridge 1 1000000', 'T 2000000', 'T 1000000'],
  bad_version: ['H tbi-bridge 2 1000000'],
  garbage: ['H tbi-bridge 1 1000000', '\u0000\u0001binary'],
}[mode];
let i = 0;
const next = () => {
  if (i < script.length) s.write(`${script[i++]}\n`);
};
s.on('connect', next);
s.on('data', (d) => {
  if (d.toString().endsWith('C\n')) next();
});
s.on('close', () => process.exit(0));
s.on('error', () => process.exit(1));

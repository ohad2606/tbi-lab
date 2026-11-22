/**
 * TBI-005: the in-app MicroPython support panel is generated from runtime/builder/pyContract.ts.
 * The structure (api, status, where it is decided, refusal id) is read from the contract at render
 * time, so it cannot drift. The sentences are translation keys, so these tests fail when:
 * - a contract entry has no EN/HE note, or a note key has no contract entry;
 * - an EN note differs from the contract's text (the contract changed: update the EN key);
 * - a contract note changed since its Hebrew translation was reviewed (REVIEWED below);
 * - a contract status or decision point has no section / label.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MICROPYTHON_CONTRACT } from '../../runtime/builder/pyContract.js';
import { en } from '../src/i18n/messages.en.js';
import { he } from '../src/i18n/messages.he.js';
import { SUPPORT_SECTIONS, entriesWithStatus } from '../src/ui/mpyContractView.js';

/** sha256 (12 hex) of each contract note at the time its Hebrew text was written/reviewed. */
const REVIEWED: Record<string, string> = {
  gpio_output: '40ba20b04a51',
  gpio_input: 'a1155087877f',
  gpio_internal_pull: '9bde2f31dfc8',
  gpio_drive_strength: 'f303faf43c31',
  signal_drive: '6e612c0781ee',
  pwm: '5143dcc828b6',
  irq_edge: '75a7ff028372',
  irq_level: 'fbe9c6a15748',
  timing: '7a151e42826a',
  pulse_timing: 'b0068ffab48b',
  dht22: 'aa52ffd85551',
  i2c: '0bd142a60b21',
  i2c_frequency: '6021b9db9935',
  i2c_read: 'c2bf3b2cd25d',
  soft_i2c: '9cf810cf3b48',
  adc: '12657341a0dd',
  dac: '9b6a839f9a70',
  spi: '9b6a839f9a70',
  touch: '60d74399c003',
  timer: '31a4a25e93d1',
  uart: 'ba7419226862',
  rtc: '9b6a839f9a70',
  cpu_frequency: 'b2d7cb9e5c01',
  sleep_modes: '9b6a839f9a70',
  restart: '8597153f3926',
  dynamic_access: '2fa7ebf1d11a',
  serial_input: 'ef572bb34505',
  network: '6abdcbc6329d',
};

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const noteKey = (id: string) => `mpy.contract.${id}.note`;

describe('MicroPython support panel parity (TBI-005)', () => {
  it('every contract entry has an EN and a HE note, and no note key is orphaned', () => {
    const want = MICROPYTHON_CONTRACT.map((e) => noteKey(e.id)).sort();
    for (const [name, messages] of [
      ['en', en],
      ['he', he],
    ] as const) {
      const have = Object.keys(messages)
        .filter((k) => k.startsWith('mpy.contract.'))
        .sort();
      expect(have, name).toEqual(want);
    }
  });

  it('the EN note is exactly the contract note', () => {
    for (const e of MICROPYTHON_CONTRACT)
      expect((en as Record<string, string>)[noteKey(e.id)], e.id).toBe(e.note);
  });

  it('the HE note is Hebrew and was reviewed against the current contract note', () => {
    expect(Object.keys(REVIEWED).sort()).toEqual(MICROPYTHON_CONTRACT.map((e) => e.id).sort());
    for (const e of MICROPYTHON_CONTRACT) {
      const t = (he as Record<string, string>)[noteKey(e.id)] ?? '';
      expect(t, e.id).toMatch(/[א-ת]/);
      expect(
        hash(e.note),
        `${e.id}: the contract note changed; update the HE text, then this hash`,
      ).toBe(REVIEWED[e.id]);
    }
  });

  it('every status has a section and a label; every decision point has a label', () => {
    const statuses = new Set(MICROPYTHON_CONTRACT.map((e) => e.status));
    for (const s of statuses) expect(SUPPORT_SECTIONS).toContain(s);
    expect(SUPPORT_SECTIONS.flatMap((s) => entriesWithStatus(s)).map((e) => e.id)).toEqual(
      expect.arrayContaining(MICROPYTHON_CONTRACT.map((e) => e.id)),
    );
    expect(SUPPORT_SECTIONS.flatMap((s) => entriesWithStatus(s))).toHaveLength(
      MICROPYTHON_CONTRACT.length,
    );
    const ats = new Set(MICROPYTHON_CONTRACT.map((e) => e.at));
    for (const messages of [en, he] as Record<string, string>[]) {
      for (const s of SUPPORT_SECTIONS) {
        expect(messages[`mpy.support.section.${s}`]).toBeTruthy();
        expect(messages[`mpy.support.status.${s}`]).toBeTruthy();
      }
      for (const a of ats) expect(messages[`mpy.support.at.${a}`]).toBeTruthy();
    }
  });
});

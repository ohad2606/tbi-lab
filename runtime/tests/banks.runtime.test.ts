/**
 * R1.2: classic-ESP32 GPIO completeness through ordinary Arduino firmware (TbiBanks).
 *
 * Both register banks (GPIO_OUT/ENABLE/IN for 0-31, GPIO_OUT1/ENABLE1/IN1 for 32-39), outputs on
 * GPIO4/16/27/25 (bank 0) and GPIO32/33 (bank 1), inputs on the input-only pads 34/35/36/39, all
 * closed through the production electrical engine:
 *
 *   each output -> 330 ohm -> red LED -> GND
 *   GPIO35 <- 1 k <- VA (lab PSU);  GPIO34 <- 1 k <- VB (lab PSU)
 *   GPIO36 <- 10 k <- 3V3 rail;     GPIO39 <- 10 k <- GND
 *
 * The firmware sweeps every output and reads it back, reports GPIO36/39, then echoes
 * GPIO35 -> GPIO33 and GPIO34 -> GPIO4 (two-way loops across banks). GPIO4/16/27 were masked by
 * the Sprint 0/1 feasibility runtime and must now be ordinary pins.
 */
import {
  Circuit,
  Diode,
  GpioPin,
  LabPsu,
  LED_TLHR5400,
  Resistor,
  VoltageSource,
} from '@tbi-lab/engine';
import { ESP32_DEVKITC_WROOM32, boardPinForGpio } from '@tbi-lab/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  runCircuitSession,
  serialLines,
  type AttachedPad,
  type CircuitSessionRecord,
} from '../harness/circuitSession.js';
import { QEMU, artifact, assertProvisioned, recordEvidence } from '../harness/env.js';

const OUTS = [4, 16, 27, 25, 32, 33];
const INS = [34, 35, 36, 39];

let rec: CircuitSessionRecord;
let lines: { vns: bigint; text: string }[];

function buildCircuit() {
  const c = new Circuit();
  const pads: AttachedPad[] = [];
  for (const g of OUTS) {
    const pin = c.add(new GpioPin(`IO${g}`, `io${g}`, 'input'));
    c.add(new Resistor(`R${g}`, `io${g}`, `a${g}`, 330));
    c.add(new Diode(`D${g}`, `a${g}`, '0', LED_TLHR5400));
    pads.push({ pad: g, pin, node: `io${g}`, input: false });
  }
  const va = c.add(new LabPsu('VA', 'va', '0', 0, 0.1));
  const vb = c.add(new LabPsu('VB', 'vb', '0', 0, 0.1));
  c.add(new VoltageSource('V3V3', 'rail', '0', 3.3));
  c.add(new Resistor('RA', 'va', 'io35', 1000));
  c.add(new Resistor('RB', 'vb', 'io34', 1000));
  c.add(new Resistor('R36', 'rail', 'io36', 10_000));
  c.add(new Resistor('R39', 'io39', '0', 10_000));
  for (const g of INS)
    pads.push({
      pad: g,
      pin: c.add(new GpioPin(`IO${g}`, `io${g}`, 'input')),
      node: `io${g}`,
      input: true,
    });
  const set = (psu: LabPsu, v: number) => ({
    label: `${psu.id}=${v}`,
    apply: () => (psu.setpointV = v),
  });
  const commands = [
    { atNs: 2_000_000_000n, command: set(va, 3.3) },
    { atNs: 2_200_000_000n, command: set(vb, 3.3) },
    { atNs: 2_500_000_000n, command: set(va, 0) },
    { atNs: 2_800_000_000n, command: set(vb, 0) },
  ];
  return { c, pads, commands };
}

beforeAll(async () => {
  assertProvisioned();
  const fw = artifact('TbiBanks');
  const { c, pads, commands } = buildCircuit();
  rec = await runCircuitSession({
    qemu: QEMU,
    artifact: fw.path,
    artifactSha256: fw.sha256,
    circuit: c,
    pads,
    endNs: 3_200_000_000n,
    commands,
  });
  lines = serialLines(rec.serialTimeline);
  recordEvidence('banks', {
    outcome: rec.session.outcome,
    timelineSha256: rec.timelineSha256,
    padEvents: rec.padEvents,
    unattached: rec.unattachedPadEvents,
    injections: rec.injections,
    serial: lines,
  });
}, 300_000);

const ledCurrentAt = (vns: bigint, g: number) =>
  rec.solves
    .filter((s) => s.vns === vns)
    .at(-1)!
    .currents.get(`D${g}`)!;

describe('R1.2 GPIO banks through Arduino firmware', () => {
  it('the session completes and the firmware ran to its sweep', () => {
    expect(rec.session.outcome, rec.session.diagnostics).toBe('completed');
    expect(lines.map((l) => l.text)).toContain('TBI-BANKS-SWEEP-DONE');
  });

  it('every output pad in both banks is driven HIGH then LOW, in firmware order', () => {
    const highs = rec.padEvents.filter((e) => e.drive === 1 && e.level === 1).map((e) => e.pad);
    expect(highs.slice(0, OUTS.length)).toEqual(OUTS);
    for (const g of OUTS) {
      const ev = rec.padEvents.filter((e) => e.pad === g).map((e) => `${e.drive}${e.level}`);
      // pinMode(OUTPUT) + digitalWrite(LOW), then HIGH, then LOW
      expect(ev.slice(0, 3), `gpio${g}`).toEqual(['10', '11', '10']);
    }
  });

  it('a HIGH output on either bank lights its LED with the same electrical result', () => {
    const currents = OUTS.map((g) => {
      const e = rec.padEvents.find((x) => x.pad === g && x.level === 1)!;
      return ledCurrentAt(e.vns, g);
    });
    for (const i of currents) {
      expect(i).toBeGreaterThan(3e-3);
      expect(i).toBeCloseTo(currents[0]!, 12); // bank 1 (32/33) identical to bank 0
    }
  });

  it('digitalRead of a driven output reads its own level on both banks', () => {
    for (const g of OUTS)
      expect(
        lines.map((l) => l.text),
        `RB${g}`,
      ).toContain(`RB${g}=1`);
  });

  it('input-only pads read the circuit: GPIO36 pulled to 3V3 reads 1, GPIO39 to GND reads 0', () => {
    expect(lines.map((l) => l.text)).toContain('IN36=1 IN39=0');
  });

  it('input-only pads never drive (no output events on 34-39)', () => {
    expect(rec.padEvents.filter((e) => e.pad >= 34).every((e) => e.drive === 0)).toBe(true);
    expect(rec.unattachedPadEvents.filter((e) => e.pad >= 34)).toEqual([]);
  });

  it('two-way loop across banks: VA -> GPIO35 -> firmware -> GPIO33 -> LED33, and back', () => {
    const inj35 = rec.injections.filter((i) => i.pad === 35 && i.vns >= 2_000_000_000n);
    expect(inj35.map((i) => i.level)).toEqual([1, 0]);
    const out33 = rec.padEvents.filter((e) => e.pad === 33 && e.vns >= 2_000_000_000n);
    expect(out33.map((e) => e.level)).toEqual([1, 0]);
    expect(out33[0]!.vns).toBeGreaterThan(inj35[0]!.vns);
    expect(out33[0]!.vns - inj35[0]!.vns).toBeLessThan(10_000_000n); // within the firmware's 5 ms poll
    expect(ledCurrentAt(out33[0]!.vns, 33)).toBeGreaterThan(3e-3);
    expect(lines.filter((l) => l.text.startsWith('ECHO35=')).map((l) => l.text)).toEqual([
      'ECHO35=0',
      'ECHO35=1',
      'ECHO35=0',
    ]);
  });

  it('two-way loop bank 1 -> bank 0: VB -> GPIO34 -> firmware -> GPIO4', () => {
    const out4 = rec.padEvents.filter((e) => e.pad === 4 && e.vns >= 2_000_000_000n);
    expect(out4.map((e) => e.level)).toEqual([1, 0]);
    expect(lines.filter((l) => l.text.startsWith('ECHO34=')).map((l) => l.text)).toEqual([
      'ECHO34=0',
      'ECHO34=1',
      'ECHO34=0',
    ]);
  });

  it('GPIO4/16/27 are ordinary: not masked, events delivered like any other pad', () => {
    for (const g of [4, 16, 27]) {
      expect(
        rec.padEvents.some((e) => e.pad === g && e.level === 1),
        `gpio${g}`,
      ).toBe(true);
      expect(boardPinForGpio(ESP32_DEVKITC_WROOM32, g)!.simulatorSupport).toBe('digital-io');
    }
  });

  it('pads the board does not offer to circuits (flash) are reported but never attached', () => {
    for (const e of rec.unattachedPadEvents) {
      const pin = boardPinForGpio(ESP32_DEVKITC_WROOM32, e.pad);
      expect(pin?.simulatorSupport ?? 'none', `gpio${e.pad}`).toBe('none');
    }
  });
});

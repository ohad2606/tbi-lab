/**
 * R1.8 / R1.5: firmware coverage and pinned artifacts.
 *
 * Arduino (pinMode / digitalWrite / digitalRead) is covered by TbiGpioProof (gate, electrical) and
 * TbiBanks (both banks). This file checks the artifact lock and MicroPython's machine.Pin in both
 * directions through the electrical engine.
 */
import { Circuit, GpioPin, LabPsu, Resistor } from '@tbi-lab/engine';
import { statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sha256File } from '../harness/artifacts.js';
import { runCircuitSession, serialLines } from '../harness/circuitSession.js';
import {
  ARTIFACT_LOCK,
  QEMU,
  artifact,
  assertProvisioned,
  recordEvidence,
} from '../harness/env.js';

describe('R1.5 pinned firmware artifacts', () => {
  assertProvisioned();

  it('every locked artifact is provisioned, byte-identical to the lock, and read-only', () => {
    for (const name of Object.keys(ARTIFACT_LOCK)) {
      const a = artifact(name);
      expect(sha256File(a.path), name).toBe(ARTIFACT_LOCK[name]!.sha256);
      expect(statSync(a.path).mode & 0o222, name).toBe(0);
      expect(statSync(a.path).size, name).toBe(4 << 20);
    }
  });
});

describe('R1.8 MicroPython machine.Pin through the electrical loop', () => {
  it('reads an input driven by the circuit and drives an output (GPIO35 in, GPIO25 out)', async () => {
    const fw = artifact('micropython');
    const c = new Circuit();
    const va = c.add(new LabPsu('VA', 'va', '0', 0, 0.1));
    c.add(new Resistor('RA', 'va', 'io35', 1000));
    const in35 = c.add(new GpioPin('IO35', 'io35', 'input'));
    const out25 = c.add(new GpioPin('IO25', 'io25', 'input'));
    c.add(new Resistor('RL', 'io25', '0', 10_000));
    const script =
      'from machine import Pin\r\n' +
      'a=Pin(35,Pin.IN)\r\n' +
      'o=Pin(25,Pin.OUT)\r\n' +
      'print("IN35", a.value())\r\n' +
      'o.value(a.value())\r\n';
    let phase = 0;
    const r = await runCircuitSession({
      qemu: QEMU,
      artifact: fw.path,
      artifactSha256: fw.sha256,
      circuit: c,
      pads: [
        { pad: 35, pin: in35, node: 'io35', input: true },
        { pad: 25, pin: out25, node: 'io25', input: false },
      ],
      endNs: 5_000_000_000n,
      commands: [
        { atNs: 2_500_000_000n, command: { label: 'VA=3.3', apply: () => (va.setpointV = 3.3) } },
      ],
      onTick: (vns) => {
        if (phase === 0 && vns >= 3_000_000_000n) {
          phase = 1;
          return [{ type: 'R', bytes: Buffer.from(script) }];
        }
        return [];
      },
    });
    expect(r.session.outcome).toBe('completed');
    const text = serialLines(r.serialTimeline).map((l) => l.text);
    expect(text).toContain('IN35 1');
    const ev25 = r.padEvents.filter((e) => e.pad === 25).map((e) => `${e.drive}${e.level}`);
    expect(ev25).toEqual(['10', '11']);
    const last = r.solves.at(-1)!;
    expect(last.voltages.get('io25')!).toBeGreaterThan(3.2); // 3.3 V behind 16.5 ohm into 10 k
    recordEvidence('micropython-pin', {
      text: text.slice(-8),
      ev25,
      io25: last.voltages.get('io25'),
    });
  });
});

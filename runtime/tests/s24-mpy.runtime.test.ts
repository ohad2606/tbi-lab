/**
 * Sprint 24 (M1 + M2) on the REAL stack: genuine MicroPython v1.29.0 on real QEMU Runtime v4,
 * every program built by the real MicroPython provider (pinned mpy-cross check, tbi-mklfs, pinned
 * image), every result read from the CIRCUIT (the engine's operating points the Session Host
 * publishes), never from printed text alone.
 *
 * - M1a: a SyntaxError is a Build failure with file, line and the compiler's message; the session
 *   never starts. Valid programs build byte-reproducibly.
 * - M1b: an uncaught exception and a normal end print the interpreter's own traceback and REPL
 *   banner (the transcripts app/tests/fixtures/s24-mpy-serial.json holds); the app's reader
 *   (programEnd.ts) finds the error line; the session is NOT failed (the board waits at the REPL).
 * - M1c: the three MicroPython examples, as the app sends them (fixtures s24-mpy-*-session.json):
 *   blink (LED current at sampled times, on/off phases), fade (LED average = duty × high-point
 *   current at every duty), and the push button (M2: Pin.IN reads the circuit; press/release
 *   changes what the program drives). Blink and button are compared with their Arduino twins (the
 *   pinned TbiGpioProof / TbiBanks firmware) on the SAME circuit request.
 * Evidence: $TBI_RUNTIME_HOME/results/s24-mpy.json (sequence hashes for the determinism runs).
 */
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { EngineSession, V_IH_V, V_IL_V, type SolveSuccess } from '@tbi-lab/engine';
import { recordEvidence, artifact } from '../harness/env.js';
import { ticketFor } from '../identity/test-gate.js';
import { PROTOCOL, type CreateSessionRequest } from '../host/protocol.js';
import type { HostSession } from '../host/session.js';
import { serialText, waitEvent } from '../host/tests/support.js';
import { open } from '../host/tests/r1-support.js';
import { realHost } from './r2-support.js';
import { micropythonProgramEnd } from '../../app/src/programs/programEnd.js';
import {
  MpyStack,
  RT,
  V4,
  electrical,
  example,
  serialMatches,
  sha,
  simNow,
} from './s24-support.js';

const stack = RT && V4 ? new MpyStack() : null;
// Sessions here have no attached event stream: a long lease, so a slow (1 CPU) host never expires
// one mid-test (the lease is wall-clock and host-side; it never touches the simulated loop).
const host = realHost(stack ? { artifactsDir: stack.store, leaseMs: 600_000 } : {});
afterAll(async () => {
  await host.shutdown();
  stack?.cleanup();
});
const evidence: Record<string, unknown> = {};

/** The engine's own solve of the request with these pad modes and buttons held (the reference). */
function ref(
  req: CreateSessionRequest,
  modes: Record<number, 'output-high' | 'output-low' | 'input'>,
  held: string[] = [],
): SolveSuccess {
  const e = new EngineSession(req.circuit, { pins: req.attachments });
  for (const id of held) e.setMomentary(id, true);
  for (const [g, m] of Object.entries(modes)) e.setPinMode(Number(g), m);
  const out = e.solve();
  if (!out.ok) throw new Error(JSON.stringify(out.error));
  return out;
}
const ledOf = (req: CreateSessionRequest) =>
  req.circuit.components.find((c) => c.type === 'component.led')!.id;
const ms = (ns: bigint) => Number(ns / 1000n) / 1000;

async function stop(s: HostSession) {
  s.stop();
  await waitEvent(
    s,
    (e) => e.type === 'state' && (e.state === 'ended' || e.state === 'failed'),
    30_000,
  );
  await s.done();
}

describe.skipIf(!stack)('Sprint 24 MicroPython on the real stack (Runtime v4)', () => {
  afterAll(() => recordEvidence('s24-mpy', evidence));

  it('M1a: a SyntaxError fails the Build with file, line and message; valid builds reproduce', async () => {
    const t0 = Date.now();
    const bad = await stack!.buildResult('import time\nx = (1,\nprint(x)\n');
    expect(bad).toMatchObject({
      ok: false,
      failure: 'compile_error',
      diagnostics: [
        { severity: 'error', file: 'main.py', line: 4, message: 'SyntaxError: invalid syntax' },
      ],
    });
    expect(bad.artifact).toBeUndefined();
    const indent = await stack!.buildResult('def f():\n    return 1\n  return 2\n');
    expect(indent.diagnostics[0]).toMatchObject({
      line: 2,
      message: expect.stringMatching(/^IndentationError: /),
    });
    const checkMs = Date.now() - t0;
    // Each example builds, twice in fresh stores, to the same bytes (the image keeps main.py).
    const images: Record<string, string> = {};
    for (const id of ['mpy-blink', 'mpy-button', 'mpy-fade']) {
      const { text } = example(id, `s24-${id}-session.json`);
      const a = await stack!.build(text);
      const other = new MpyStack();
      try {
        const b = await other.build(text);
        expect(b.artifact!.sha256, id).toBe(a.artifact!.sha256);
      } finally {
        other.cleanup();
      }
      expect(a.features).toEqual({
        internalPull: [],
        gpioInterrupt: [],
        restart: false,
        unsupported: [],
        requires: ['unmodelled'],
      });
      images[id] = a.artifact!.sha256;
    }
    evidence.build = { syntaxErrorDiagnostic: bad.diagnostics, checkMs, images };
  });

  it('M1b: an uncaught exception and a normal end: the interpreter’s own ending; the session keeps running', async () => {
    const golden = JSON.parse(
      readFileSync(
        new URL('../../app/tests/fixtures/s24-mpy-serial.json', import.meta.url),
        'utf8',
      ),
    ) as Record<'error' | 'finished', { program: string; serial: string }>;
    const { request } = example('mpy-blink', 's24-mpy-blink-session.json');
    for (const kind of ['error', 'finished'] as const) {
      const { s } = await stack!.run(host, golden[kind].program, request);
      await serialMatches(s, />>> $/, 120_000);
      const t = simNow(s);
      // Nothing more follows: the board waits at the REPL (idle: no further runtime events), and
      // the session is running, not failed.
      const before = serialText(s);
      await new Promise((r) => setTimeout(r, 2_000));
      expect(s.status().state).toBe('running');
      const serial = serialText(s);
      expect(serial).toBe(before);
      expect(serial, kind).toBe(golden[kind].serial);
      const end = micropythonProgramEnd(serial);
      if (kind === 'error')
        expect(end).toMatchObject({
          kind: 'error',
          line: 4,
          exception: 'ZeroDivisionError: divide by zero',
        });
      else expect(end).toEqual({ kind: 'finished' });
      evidence[`end_${kind}`] = { end, endedAtMs: ms(t) };
      await stop(s);
    }
  });

  it('M1c blink: GPIO2 LED current is exactly the output-high operating point, on/off every 500 ms; = Arduino twin', async () => {
    const { text, request } = example('mpy-blink', 's24-mpy-blink-session.json');
    const { s, req } = await stack!.run(host, text, request);
    const led = ledOf(req);
    const high = ref(req, { 2: 'output-high' }).components[led]!.current!;
    const low = ref(req, { 2: 'output-low' }).components[led]!.current!;
    expect(high).toBeGreaterThan(5e-3);
    // Four full periods after the first "LED on".
    await waitEvent(s, () => (serialText(s).match(/LED on/g) ?? []).length >= 5, 240_000);
    const samples = electrical(s).filter((x) => x.o.components[led]?.current != null);
    const runs: { on: boolean; at: bigint }[] = [];
    for (const { t, o } of samples) {
      const i = o.components[led]!.current!;
      const on = i > 1e-3;
      // Every sample is exactly one of the two operating points the engine computes for the pad.
      expect(i, `t=${ms(t)} ms`).toBe(on ? high : low);
      if (runs.at(-1)?.on !== on) runs.push({ on, at: t });
    }
    const starts = runs.filter((r) => r.on).map((r) => r.at);
    const periods = starts.slice(1).map((t, k) => ms(t - starts[k]!));
    const onTimes = runs.slice(0, -1).map((r, k) => ({ on: r.on, ms: ms(runs[k + 1]!.at - r.at) }));
    expect(periods.length).toBeGreaterThanOrEqual(3);
    for (const p of periods) expect(p).toBeGreaterThanOrEqual(1000);
    for (const p of periods) expect(p).toBeLessThan(1040);
    evidence.blink = {
      highA: high,
      lowA: low,
      periodsMs: periods,
      phasesMs: onTimes,
      seq: sha(runs.map((r) => `${r.on ? 1 : 0}@${r.at}`).join(',')),
      serial: sha(serialText(s)),
    };
    await stop(s);

    // The Arduino twin (pinned TbiGpioProof, the esp32-blink firmware: GPIO2 high 400 ms of 800 ms)
    // on the SAME circuit request: the same high-point LED current.
    const fw = artifact('TbiGpioProof');
    const arduinoHost = realHost({ leaseMs: 600_000 });
    try {
      const a = open(arduinoHost, {
        ...request,
        protocol: PROTOCOL,
        artifact: { sha256: fw.sha256 },
        ticket: ticketFor(fw.sha256),
      });
      expect(a.run()).toEqual({ ok: true });
      await waitEvent(
        a,
        (e) =>
          e.type === 'electrical' &&
          ((e as unknown as { outcome: SolveSuccess }).outcome.components[led]?.current ?? 0) >
            1e-3,
        120_000,
      );
      const arduinoHigh = electrical(a).at(-1)!.o.components[led]!.current!;
      expect(arduinoHigh).toBe(high);
      (evidence.blink as Record<string, unknown>).arduinoTwinHighA = arduinoHigh;
      await stop(a);
    } finally {
      await arduinoHost.shutdown();
    }
  });

  it('M1c fade: at every duty the LED averages exactly duty × its high-point current; never refused', async () => {
    const { text, request } = example('mpy-fade', 's24-mpy-fade-session.json');
    const { s, req } = await stack!.run(host, text, request);
    const led = ledOf(req);
    const high = ref(req, { 18: 'output-high' }).components[led]!.current!;
    const seen = new Map<number, number>();
    const seq: string[] = [];
    const expected = Array.from({ length: 31 }, (_, k) => ((k + 1) * 2048) / 65536);
    await waitEvent(
      s,
      (e) => {
        if (e.type === 'electrical') {
          const o = (e as unknown as { outcome: SolveSuccess }).outcome;
          const pin = o.pins?.find((p) => p.gpio === 18);
          const r = o.components[led];
          if (pin?.pwm && r?.current != null) {
            if (!seen.has(pin.pwm.duty)) seq.push(`${pin.pwm.duty}:${r.current}`);
            seen.set(pin.pwm.duty, r.current);
          }
        }
        return seen.size >= expected.length;
      },
      240_000,
    );
    expect([...seen.keys()].sort((a, b) => a - b)).toEqual(expected);
    for (const d of expected) expect(seen.get(d)!, `duty ${d}`).toBeCloseTo(d * high, 12);
    expect(s.status().state).toBe('running');
    evidence.fade = {
      highA: high,
      duties: expected.length,
      minA: seen.get(expected[0]!),
      maxA: seen.get(expected.at(-1)!),
      seq: sha(seq.join(',')),
    };
    await stop(s);
  });

  it('M2 button: Pin.IN reads the circuit; held lights the LED, released turns it off; = Arduino twin', async () => {
    const { text, request } = example('mpy-button', 's24-mpy-button-session.json');
    const btn = request.circuit.components.find((c) => c.type === 'component.push_button')!.id;
    const pressAndRelease = async (s: HostSession, req: CreateSessionRequest, seq0: number) => {
      const led = ledOf(req);
      const at = (pred: (o: SolveSuccess) => boolean, after: number) =>
        waitEvent(
          s,
          (e) =>
            e.seq > after &&
            e.type === 'electrical' &&
            pred((e as unknown as { outcome: SolveSuccess }).outcome),
          120_000,
        ).then(() => electrical(s).at(-1)!);
      const pad34 = (o: SolveSuccess) => o.pins!.find((p) => p.gpio === 34)!.voltage;
      const i = (o: SolveSuccess) => o.components[led]!.current!;
      /** When the host applied a transient command (its simulation time). */
      const applied = (commandSeq: number) =>
        waitEvent(
          s,
          (e) => e.type === 'command' && e.commandSeq === commandSeq && e.result === 'applied',
          60_000,
        ).then((e) => (e.simNs === null ? simNow(s) : BigInt(e.simNs)));
      const before = electrical(s).at(-1)!;
      expect(
        s.submit({ category: 'transient', seq: seq0, action: 'press', component: btn }),
      ).toMatchObject({ accepted: true });
      const pressSeq = s.log.since(0).at(-1)!.seq;
      const on = await at((o) => i(o) > 1e-3, pressSeq);
      const pressT = await applied(seq0);
      expect(
        s.submit({ category: 'transient', seq: seq0 + 1, action: 'release', component: btn }),
      ).toMatchObject({ accepted: true });
      const releaseSeq = s.log.since(0).at(-1)!.seq;
      const off = await at((o) => i(o) < 1e-6, releaseSeq);
      const releaseT = await applied(seq0 + 1);
      return {
        before: { i: i(before.o), v34: pad34(before.o) },
        on: { i: i(on.o), v34: pad34(on.o), afterPressMs: ms(on.t - pressT) },
        off: { i: i(off.o), v34: pad34(off.o), afterReleaseMs: ms(off.t - releaseT) },
      };
    };

    const { s, req } = await stack!.run(host, text, request);
    const led = ledOf(req);
    await serialMatches(s, /button released\r\n/, 120_000);
    const r = await pressAndRelease(s, req, 1);
    await serialMatches(s, /button held\r\nbutton released\r\n$/, 60_000);
    // What the program read is the circuit's level: released below V_IL, held above V_IH.
    expect(r.before.v34).toBeLessThan(V_IL_V);
    expect(r.on.v34).toBeGreaterThan(V_IH_V);
    expect(r.off.v34).toBeLessThan(V_IL_V);
    // And what it drove is the engine's own operating point for GPIO4 high (button held) / low.
    const heldHigh = ref(req, { 4: 'output-high', 34: 'input' }, [btn]).components[led]!.current!;
    const releasedLow = ref(req, { 4: 'output-low', 34: 'input' }).components[led]!.current!;
    expect(r.on.i).toBe(heldHigh);
    expect(r.off.i).toBe(releasedLow);
    expect(r.before.i).toBe(releasedLow);
    // The 10 ms poll plus the 1 ms input tick bound the reaction (simulated time).
    expect(r.on.afterPressMs).toBeLessThan(25);
    expect(r.off.afterReleaseMs).toBeLessThan(25);
    evidence.button = { ...r, serial: sha(serialText(s)), seq: sha(JSON.stringify(r)) };
    await stop(s);

    // The Arduino twin: TbiBanks (the esp32-input-echo firmware, GPIO34 copied to GPIO4) on the
    // SAME circuit request.
    const fw = artifact('TbiBanks');
    const arduinoHost = realHost({ leaseMs: 600_000 });
    try {
      const a = open(arduinoHost, {
        ...request,
        protocol: PROTOCOL,
        artifact: { sha256: fw.sha256 },
        ticket: ticketFor(fw.sha256),
      });
      expect(a.run()).toEqual({ ok: true });
      await serialMatches(a, /TBI-BANKS-SWEEP-DONE/, 120_000);
      await new Promise((r) => setTimeout(r, 1_000));
      const t = await pressAndRelease(a, req, 1);
      expect(t.on.i).toBe(r.on.i);
      expect(t.off.i).toBe(r.off.i);
      (evidence.button as Record<string, unknown>).arduinoTwin = t;
      await stop(a);
    } finally {
      await arduinoHost.shutdown();
    }
    void led;
  });
});

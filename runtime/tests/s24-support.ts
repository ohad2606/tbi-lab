/**
 * Sprint 24 real-stack support: MicroPython programs built by the REAL MicroPython provider (the
 * pinned mpy-cross check, tbi-mklfs, the pinned interpreter image) through the BuildService, leased,
 * and run by the Session Host on real QEMU Runtime v4. Needs TBI_RUNTIME_HOME with the MicroPython
 * build home (provision.sh mpy-cross + micropython-tools) and TBI_QEMU = a Runtime v4 binary.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import {
  ESP32_ARDUINO_PROFILE,
  ESP32_MICROPYTHON_PROFILE,
  programInputReads,
} from '@tbi-lab/domain';
import type { SolveSuccess } from '@tbi-lab/engine';
import { ArduinoEsp32Provider, type ArduinoProfileRecord } from '../builder/arduino.js';
import { Grants } from '../builder/grants.js';
import arduinoRecord from '../builder/profiles/esp32-arduino-3.3.12.json' with { type: 'json' };
import { MicroPythonProvider, type MicroPythonProfileRecord } from '../builder/micropython.js';
import record from '../builder/profiles/esp32-micropython-1.29.json' with { type: 'json' };
import type { BuildResult } from '../builder/protocol.js';
import { BuildService, DEFAULT_LIMITS } from '../builder/service.js';
import { ArtifactStore } from '../builder/store.js';
import { principalFor, TEST_TICKET_KEY, ticketFor } from '../identity/test-gate.js';
import { openAccessPolicy } from '../policy/testing.js';
import { PROTOCOL, type CreateSessionRequest, type SessionEvent } from '../host/protocol.js';
import type { SessionHost } from '../host/host.js';
import type { HostSession } from '../host/session.js';
import { serialText, waitEvent } from '../host/tests/support.js';
import { open } from '../host/tests/r1-support.js';

export const RT = process.env.TBI_RUNTIME_HOME ?? '';
export const V4 = (process.env.TBI_QEMU ?? '').length > 0;
const A = principalFor();

/** The runtime's capabilities (its provisioned runtime.json). */
export const runtimeCaps = (): string[] =>
  (
    JSON.parse(readFileSync(join(RT, 'qemu-current', 'runtime.json'), 'utf8')) as {
      capabilities?: string[];
    }
  ).capabilities ?? [];

/**
 * Sprint 25: the features a build reports on the provisioned runtime. On a Runtime v5 (`input-read`)
 * every build also declares the inputs it reads (the host watches them) and requires the v5
 * capabilities it relies on, so a rolled-back v4 runtime refuses it; on v4 the expectation is unchanged.
 */
export function onRuntime<T extends { requires?: string[] }>(
  expected: T,
  language: 'arduino-cpp' | 'micropython',
  text: string,
  caps: readonly string[] = runtimeCaps(),
): T & { inputReads?: { pins: number[]; unresolved: boolean } } {
  if (!caps.includes('input-read')) return expected;
  const extra = [
    'input-read',
    ...(expected.requires?.includes('i2c') && caps.includes('i2c-clock') ? ['i2c-clock'] : []),
  ];
  return {
    ...expected,
    requires: [...(expected.requires ?? []), ...extra].sort(),
    inputReads: programInputReads({
      language,
      profile: '',
      fileName: language === 'micropython' ? 'main.py' : 'sketch.ino',
      text,
    }),
  };
}

export class MpyStack {
  readonly store = mkdtempSync(join('/var/tmp', 's24-mpy-store-'));
  readonly work = mkdtempSync(join('/var/tmp', 's24-mpy-work-'));
  readonly service: BuildService;
  constructor(capabilities: readonly string[] = runtimeCaps()) {
    this.service = MpyStack.newService(this.store, this.work, capabilities);
  }
  static newService(store: string, work: string, capabilities: readonly string[]) {
    return new BuildService(
      [
        new MicroPythonProvider({
          profile: ESP32_MICROPYTHON_PROFILE,
          record: record as MicroPythonProfileRecord,
          home: join(RT, 'micropython'),
          runtimeCapabilities: capabilities,
        }),
      ],
      new ArtifactStore({ dir: store, capBytes: 256 * 1024 * 1024, graceMs: 0 }),
      work,
      DEFAULT_LIMITS,
      {
        grants: new Grants(':memory:'),
        ticketKey: TEST_TICKET_KEY,
        systemKeys: new Set(),
        ...openAccessPolicy(),
      },
    );
  }
  cleanup() {
    for (const d of [this.store, this.work]) rmSync(d, { recursive: true, force: true });
  }

  /** Build main.py; the result whether it succeeded or not. */
  async buildResult(text: string, s = this.service): Promise<BuildResult> {
    const out = s.submit(
      {
        protocol: 'tbi-lab.build/1',
        profile: ESP32_MICROPYTHON_PROFILE.id,
        files: [{ name: 'main.py', text }],
      },
      A,
    );
    if (!('cached' in out)) await s.whenIdle();
    return 'cached' in out ? out.cached : s.status(out.buildId, out.token, A)!.result!;
  }
  async build(text: string, s = this.service): Promise<BuildResult> {
    const r = await this.buildResult(text, s);
    expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true);
    return r;
  }

  /** Build `text`, lease it and start `request` (a fixture: the app's request) with it. */
  async run(
    host: SessionHost,
    text: string,
    request: Omit<CreateSessionRequest, 'artifact' | 'ticket' | 'protocol'>,
  ): Promise<{ s: HostSession; req: CreateSessionRequest; build: BuildResult }> {
    const build = await this.build(text);
    const lease = this.service.lease(A, build.artifact!.sha256, 600_000)!;
    const req: CreateSessionRequest = {
      ...request,
      protocol: PROTOCOL,
      artifact: { sha256: build.artifact!.sha256 },
      ticket: lease.ticket,
    };
    const s = open(host, req);
    expect(s.state, JSON.stringify(s.status().detail)).toBe('ready');
    expect(s.run()).toEqual({ ok: true });
    return { s, req, build };
  }
}

/**
 * Sprint 25: an Arduino example's OWN sketch, built by the real Arduino provider on the provisioned
 * runtime's capabilities, its image placed in $TBI_RUNTIME_HOME/artifacts (where `realHost()`
 * serves firmware), and a ticket carrying the build's features (its input reads included), as the
 * build service would issue it. Built once per example per test file.
 */
const builtExamples = new Map<string, Promise<{ sha256: string; ticket: () => string }>>();
export function builtExample(id: string): Promise<{ sha256: string; ticket: () => string }> {
  let p = builtExamples.get(id);
  if (!p) {
    p = (async () => {
      const doc = JSON.parse(
        readFileSync(new URL(`../../app/src/examples/data/${id}.json`, import.meta.url), 'utf8'),
      ) as { programs: Record<string, { text: string }> };
      const text = Object.values(doc.programs)[0]!.text;
      const store = mkdtempSync(join('/var/tmp', 's25-example-store-'));
      const work = mkdtempSync(join('/var/tmp', 's25-example-work-'));
      try {
        const svc = new BuildService(
          [
            new ArduinoEsp32Provider({
              profile: ESP32_ARDUINO_PROFILE,
              record: arduinoRecord as ArduinoProfileRecord,
              home: join(RT, 'arduino'),
              retainedOutputBytes: 256 * 1024,
              runtimeCapabilities: runtimeCaps(),
            }),
          ],
          new ArtifactStore({ dir: store, capBytes: 256 * 1024 * 1024, graceMs: 0 }),
          work,
          DEFAULT_LIMITS,
          {
            grants: new Grants(':memory:'),
            ticketKey: TEST_TICKET_KEY,
            systemKeys: new Set(),
            ...openAccessPolicy(),
          },
        );
        const out = svc.submit(
          {
            protocol: 'tbi-lab.build/1',
            profile: ESP32_ARDUINO_PROFILE.id,
            files: [{ name: 'sketch.ino', text }],
          },
          A,
        );
        if (!('cached' in out)) await svc.whenIdle();
        const r = 'cached' in out ? out.cached : svc.status(out.buildId, out.token, A)!.result!;
        expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true);
        const sha256 = r.artifact!.sha256;
        // Content-addressed: an image already there under this hash is these bytes (the host
        // verifies the hash at every session).
        const dest = join(RT, 'artifacts', `${sha256}.bin`);
        if (!existsSync(dest)) copyFileSync(join(store, `${sha256}.bin`), dest);
        const features = r.features!;
        return { sha256, ticket: () => ticketFor(sha256, A, features) };
      } finally {
        for (const d of [store, work]) rmSync(d, { recursive: true, force: true });
      }
    })();
    builtExamples.set(id, p);
  }
  return p;
}

/** A fixture request (the app's request for an example) and the example's main.py. */
export function example(id: string, fixture: string) {
  const doc = JSON.parse(
    readFileSync(new URL(`../../app/src/examples/data/${id}.json`, import.meta.url), 'utf8'),
  ) as { programs: Record<string, { text: string; profile: string }> };
  const fx = JSON.parse(
    readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), 'utf8'),
  ) as { request: Omit<CreateSessionRequest, 'artifact' | 'ticket'> };
  return { text: Object.values(doc.programs)[0]!.text, request: fx.request };
}

/** Every electrical outcome of the session so far, with its simulation time (ns). */
export function electrical(s: HostSession): { t: bigint; o: SolveSuccess }[] {
  return s.log
    .since(0)
    .filter((e) => e.type === 'electrical' && e.simNs !== null)
    .map((e) => ({
      t: BigInt(e.simNs!),
      o: (e as SessionEvent & { outcome: SolveSuccess }).outcome,
    }));
}

export const sha = (x: string) => createHash('sha256').update(x).digest('hex');

export const terminal = (s: HostSession, ms = 240_000) =>
  waitEvent(s, (e) => e.type === 'state' && (e.state === 'failed' || e.state === 'ended'), ms).then(
    () => s.status(),
  );

/** Wait until the serial output matches. */
export const serialMatches = (s: HostSession, re: RegExp, ms = 240_000) =>
  waitEvent(s, () => re.test(serialText(s)), ms);

/** Simulated time of the latest runtime event, ns. */
export const simNow = (s: HostSession): bigint => {
  const ev = s.log.since(0).filter((e) => e.simNs !== null);
  return ev.length ? BigInt(ev.at(-1)!.simNs!) : 0n;
};

/** Wait until simulated time has advanced `ms` beyond `from`. */
export const simAdvance = (s: HostSession, from: bigint, ms: number, wallMs = 240_000) =>
  waitEvent(
    s,
    (e) => e.simNs !== null && BigInt(e.simNs) >= from + BigInt(ms) * 1_000_000n,
    wallMs,
  );

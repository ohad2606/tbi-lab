/**
 * Sprint 11 (R1), REAL runtime: the two curated examples exactly as the app sends them
 * (fixtures/r1-*-session.json, kept equal to the app by app/tests/runtime-fixtures.test.ts), on
 * the pinned TbiBanks firmware (the examples' program: GPIO34 copied to GPIO4). Live part
 * parameters are mirrored as the browser does (ADR-010). Values equal the engine.
 */
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { EngineSession, type SolveSuccess } from '@tbi-lab/engine';
import { artifact } from '../harness/env.js';
import { ticketFor } from '../identity/test-gate.js';
import { PROTOCOL, type CreateSessionRequest } from '../host/protocol.js';
import type { HostSession } from '../host/session.js';
import { waitEvent } from '../host/tests/support.js';
import { realHost } from './r2-support.js';
import { close, started, stopped } from './r1-support.js';

const host = realHost();
afterAll(() => host.shutdown());

function fixture(name: string): CreateSessionRequest {
  const fx = JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as {
    request: Omit<CreateSessionRequest, 'artifact' | 'ticket'>;
  };
  const fw = artifact('TbiBanks');
  return {
    ...fx.request,
    protocol: PROTOCOL,
    artifact: { sha256: fw.sha256 },
    ticket: ticketFor(fw.sha256),
  };
}

/** Mirror a live part parameter at the next revision; resolve with the first matching outcome. */
function live(s: HostSession, req: CreateSessionRequest) {
  let seq = 0;
  let rev = req.circuit.projectRevision;
  return async (
    component: string,
    params: Record<string, number | boolean>,
    pred: (o: SolveSuccess) => boolean,
  ) => {
    const at = s.log.lastSeq;
    expect(
      s.submit({
        category: 'mirror',
        seq: ++seq,
        projectRevision: ++rev,
        component,
        control: { params },
      }),
    ).toMatchObject({ accepted: true });
    const e = await waitEvent(
      s,
      (x) =>
        x.seq > at &&
        x.type === 'electrical' &&
        pred((x as unknown as { outcome: SolveSuccess }).outcome),
      60_000,
    );
    return { out: (e as unknown as { outcome: SolveSuccess }).outcome, rev };
  };
}

function engine(
  req: CreateSessionRequest,
  component: string,
  params: Record<string, number | boolean>,
  rev: number,
  high: number[],
) {
  const e = new EngineSession(req.circuit, { pins: req.attachments });
  e.applyControl(component, { params }, rev);
  for (const g of high) e.setPinMode(g, 'output-high');
  const out = e.solve();
  if (!out.ok) throw new Error(JSON.stringify(out.error));
  return out;
}

describe('the R1 curated examples on the real runtime', () => {
  it('esp32-motion-relay: motion pulls the relay in; the alarm LED lights and the buzzer sounds', async () => {
    const req = fixture('r1-motion-relay-session.json');
    const s = await started(host, req);
    const set = live(s, req);
    const alarm = (o: SolveSuccess) =>
      o.components.K1!.state!.energized === true &&
      (o.components.D2!.current ?? 0) > 1e-3 &&
      o.components.BZ1!.state!.sounding === true;
    const { out, rev } = await set('U2', { motion: true }, alarm);
    const want = engine(req, 'U2', { motion: true }, rev, [4]);
    close(out.components.D2!.current!, want.components.D2!.current!, 'alarm LED');
    close(out.components.BZ1!.current!, want.components.BZ1!.current!, 'buzzer');
    close(out.components.K1!.currents!.coil!, want.components.K1!.currents!.coil!, 'coil');
    expect(out.components.Q1!.state).toMatchObject({ region: 'saturation' });
    await set(
      'U2',
      { motion: false },
      (o) =>
        o.components.K1!.state!.energized === false &&
        Math.abs(o.components.D2!.current ?? 0) < 1e-9,
    );
    await stopped(s);
  });

  it('esp32-night-light: dark lights all three channels (white); bright turns them off', async () => {
    const req = fixture('r1-night-light-session.json');
    const s = await started(host, req);
    const set = live(s, req);
    const ch = (o: SolveSuccess) => o.components.D1!.currents!;
    const white = (o: SolveSuccess) =>
      ['red', 'green', 'blue'].every((k) => (ch(o)[k] ?? 0) > 1e-3);
    // Starts bright (300 lx): GPIO34 LOW, dark LED.
    const { out, rev } = await set('LDR1', { illuminance: 1 }, white);
    const want = engine(req, 'LDR1', { illuminance: 1 }, rev, [4]);
    for (const k of ['red', 'green', 'blue']) close(ch(out)[k]!, ch(want)[k]!, k);
    await set('LDR1', { illuminance: 300 }, (o) =>
      ['red', 'green', 'blue'].every((k) => Math.abs(ch(o)[k] ?? 0) < 1e-9),
    );
    await stopped(s);
  });
});

/**
 * Sprint 10 runtime sync: the Session Host simulates with the Sprint 10 engine, so the approved
 * LED colour cards (red TLHR5400, yellow TLHY5400, green TLHG4900) work under a running board,
 * from the same model definitions the browser uses (`@tbi-lab/engine` MODEL_CARDS); parts the
 * ESP32 runtime does not simulate (catalog `mcuRuntime: false`) are refused exactly as before;
 * /health reports the runtime's build identity only when the bundle was stamped.
 * Routine CI: the fake runtime speaks the real bridge protocol (no QEMU).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  CATALOG,
  CATALOG_ORDER,
  addComponent,
  addWire,
  createSnapshot,
  setParam,
  type ComponentTypeId,
  type ParamValue,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { MODEL_CARDS, ratingWarnings, type SolveSuccess } from '@tbi-lab/engine';
import { principalFor } from '../../identity/test-gate.js';
import type { SessionHost } from '../host.js';
import type { HostSession } from '../session.js';
import { runtimeIdentity } from '../identity.js';
import { benchCircuit, createRequest, fakeHost, waitEvent, waitState } from './support.js';

const hosts: SessionHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.shutdown();
});

/** The host bench circuit plus `extend` (more parts on PSU1), as the browser would send it. */
function request(
  sha: string,
  extend: (e: {
    add: (t: ComponentTypeId) => string;
    wire: (a: string, b: string) => void;
    set: (id: string, k: string, v: ParamValue) => void;
  }) => void,
) {
  const { doc: base, attachments } = benchCircuit();
  let doc: ProjectDocument = base;
  let x = 2000;
  const add = (t: ComponentTypeId) => {
    x += 200;
    const r = addComponent(doc, t, { x, y: 800 });
    if (!r.ok) throw new Error(r.error);
    doc = r.doc;
    return r.id;
  };
  const wire = (a: string, b: string) => {
    const [ac, at] = a.split('.') as [string, string];
    const [bc, bt] = b.split('.') as [string, string];
    const r = addWire(
      doc,
      { kind: 'terminal', component: ac, terminal: at },
      { kind: 'terminal', component: bc, terminal: bt },
    );
    if (!r.ok) throw new Error(`${a}-${b}: ${r.error}`);
    doc = r.doc;
  };
  const set = (id: string, k: string, v: ParamValue) => {
    const r = setParam(doc, id, k, v);
    if (!r.ok) throw new Error(r.error);
    doc = r.doc;
  };
  extend({ add, wire, set });
  return { req: createRequest(sha, { circuit: createSnapshot(doc), attachments }), doc };
}

/** PSU1+ -> R (ohms) -> LED (card, anode first unless reversed) -> GND. */
function ledBranch(
  e: Parameters<Parameters<typeof request>[1]>[0],
  model: string,
  ohms: number,
  reversed = false,
) {
  const r = e.add('component.resistor');
  const d = e.add('component.led');
  e.set(r, 'resistance', { value: ohms, unit: 'ohm' });
  e.set(d, 'model', model);
  e.wire('PSU1.positive', `${r}.a`);
  e.wire(`${r}.b`, `${d}.${reversed ? 'cathode' : 'anode'}`);
  e.wire(`${d}.${reversed ? 'anode' : 'cathode'}`, 'GND1.ref');
  return d;
}

/** Independent reference (bisection of V = V_j + R I(V_j)), as the engine's own card tests. */
function reference(model: string, volts: number, ohms: number): number {
  const m = MODEL_CARDS[model]!;
  const vt = (1.380649e-23 * m.temperatureK) / 1.602176634e-19;
  const i = (v: number) => m.saturationCurrentA * (Math.exp(v / (m.emissionCoefficient * vt)) - 1);
  let lo = 0;
  let hi = volts;
  for (let k = 0; k < 200; k++) {
    const mid = 0.5 * (lo + hi);
    if (volts - mid - ohms * i(mid) > 0) lo = mid;
    else hi = mid;
  }
  return i(0.5 * (lo + hi));
}

const RED = 'model.led.vishay_tlhr5400';
const YELLOW = 'model.led.vishay_tlhy5400';
const GREEN = 'model.led.vishay_tlhg4900';

async function operatingPoint(s: HostSession): Promise<SolveSuccess> {
  expect(s.state).toBe('ready');
  expect(s.run()).toEqual({ ok: true });
  const e = await waitEvent(s, (x) => x.type === 'electrical');
  const out = (e as unknown as { outcome: SolveSuccess }).outcome;
  expect(out.ok).toBe(true);
  return out;
}

function open(host: SessionHost, req: ReturnType<typeof request>['req']): HostSession {
  const r = host.create(req, principalFor());
  if (!r.ok) throw new Error(r.error);
  return r.value.session;
}

describe('LED model cards under a running board (the Sprint 10 engine in the runtime)', () => {
  it('red, yellow and green cards in one circuit: accepted, each at its independent reference', async () => {
    const { host, art } = fakeHost();
    hosts.push(host);
    const ids: Record<string, string> = {};
    const { req } = request(art.sha256, (e) => {
      ids[RED] = ledBranch(e, RED, 150);
      ids[YELLOW] = ledBranch(e, YELLOW, 150);
      ids[GREEN] = ledBranch(e, GREEN, 150);
    });
    const s = open(host, req);
    const out = await operatingPoint(s);
    for (const model of [RED, YELLOW, GREEN]) {
      const c = out.components[ids[model]!]!;
      const ref = reference(model, 3.3, 150);
      expect(Math.abs(c.current! - ref) / ref, model).toBeLessThan(1e-6);
      expect(c.outsideModelRange ?? false, model).toBe(false);
    }
    // Higher forward voltage: less current than red through the same resistor.
    expect(out.components[ids[YELLOW]!]!.current!).toBeLessThan(
      out.components[ids[RED]!]!.current!,
    );
    expect(out.components[ids[GREEN]!]!.current!).toBeLessThan(out.components[ids[RED]!]!.current!);
    s.stop();
    await waitState(s, 'ended');
  });

  it('polarity: a reversed yellow or green LED blocks (no forward current)', async () => {
    for (const model of [YELLOW, GREEN]) {
      const { host, art } = fakeHost();
      hosts.push(host);
      let d = '';
      const { req } = request(art.sha256, (e) => {
        d = ledBranch(e, model, 150, true);
      });
      const s = open(host, req);
      const out = await operatingPoint(s);
      expect(Math.abs(out.components[d]!.current!), model).toBeLessThan(1e-9);
      s.stop();
      await waitState(s, 'ended');
    }
  });

  it('over-driven yellow and green cards are flagged by the same rating rules as red', async () => {
    const { host, art } = fakeHost();
    hosts.push(host);
    const ids: string[] = [];
    const { req, doc } = request(art.sha256, (e) => {
      // 3.3 V straight through 22 ohm: far beyond each card's 30 mA continuous rating (the supply's
      // limit raised so it stays in CV: three such branches exceed the default limit).
      e.set('PSU1', 'currentLimit', { value: 1, unit: 'ampere' });
      for (const m of [RED, YELLOW, GREEN]) ids.push(ledBranch(e, m, 22));
    });
    const s = open(host, req);
    const out = await operatingPoint(s);
    expect(out.components.PSU1!.mode).toBe('cv');
    const warned = ratingWarnings(createSnapshot(doc), out);
    for (const id of ids)
      expect(
        warned.some((w) => w.component === id && w.code === 'forward_current'),
        id,
      ).toBe(true);
    s.stop();
    await waitState(s, 'ended');
  });
});

describe('parts the ESP32 runtime does not simulate are refused exactly as before', () => {
  // Sprint 11: whatever the catalog still flags (the capacitor at the end of R1).
  for (const type of CATALOG_ORDER.filter((t) => CATALOG[t].mcuRuntime === false))
    it(`${type}: failed / electrical_error, unsupported_component, before any runtime starts`, () => {
      const { host, art } = fakeHost();
      hosts.push(host);
      let id = '';
      const { req } = request(art.sha256, (e) => {
        id = e.add(type);
      });
      const s = open(host, req);
      expect(s.status()).toMatchObject({ state: 'failed', reason: 'electrical_error' });
      const failed = s.log
        .since(0)
        .filter((e) => e.type === 'state')
        .at(-1) as unknown as { detail?: unknown };
      expect(failed.detail).toEqual({ code: 'unsupported_component', components: [id] });
      expect(s.status().runtime.pid).toBeNull();
    });
});

describe('runtime build identity on /health', () => {
  const g = globalThis as Record<string, unknown>;
  afterEach(() => {
    delete g.__TBI_RUNTIME_VERSION__;
    delete g.__TBI_RUNTIME_COMMIT__;
  });
  it('unstamped (tests, plain builds): nothing is reported', () => {
    expect(runtimeIdentity()).toBeNull();
  });
  it('stamped: the product version and the full commit, nothing else; malformed stamps are dropped', () => {
    g.__TBI_RUNTIME_VERSION__ = '0.10-dev';
    g.__TBI_RUNTIME_COMMIT__ = 'a'.repeat(40);
    expect(runtimeIdentity()).toEqual({ version: '0.10-dev', commit: 'a'.repeat(40) });
    g.__TBI_RUNTIME_COMMIT__ = '/home/user/repo';
    expect(runtimeIdentity()).toBeNull();
  });
});

/**
 * Shared support for the Session Host tests (routine CI: no QEMU; the fake runtime speaks the
 * real bridge protocol). Circuits are real domain projects, snapshotted as the browser does.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll } from 'vitest';
import {
  addComponent,
  addWire,
  createProject,
  createSnapshot,
  setParam,
  type ComponentTypeId,
  type ParamValue,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { defaultConfig, type HostConfig } from '../config.js';
import { SessionHost } from '../host.js';
import { PROTOCOL, type CreateSessionRequest, type SessionEvent } from '../protocol.js';
import type { HostSession } from '../session.js';

export const FAKE_RUNTIME = fileURLToPath(new URL('./fixtures/fake-runtime.mjs', import.meta.url));

/** Artifact directories this test file created; removed after the file's tests. */
const created: string[] = [];
afterAll(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A directory of immutable artifacts: one 4 MiB erased image, named by its sha256. */
export function artifactsDir(): { dir: string; sha256: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tbi-art-'));
  created.push(dir);
  const img = Buffer.alloc(4 << 20, 0xff);
  const sha256 = createHash('sha256').update(img).digest('hex');
  const path = join(dir, `${sha256}.bin`);
  writeFileSync(path, img);
  chmodSync(path, 0o444);
  return { dir, sha256, path };
}

export function fakeHost(mode = 'normal', over: Partial<HostConfig> = {}) {
  const art = artifactsDir();
  const host = new SessionHost(
    defaultConfig({
      qemu: FAKE_RUNTIME,
      artifactsDir: art.dir,
      runtimeEnv: { PATH: process.env.PATH, TBI_FAKE_MODE: mode },
      startupTimeoutMs: 3_000,
      stallTimeoutMs: 1_500,
      quitGraceMs: 1_000,
      killGraceMs: 300,
      housekeepingMs: 50,
      ...over,
    }),
  );
  return { host, art };
}

/**
 * PSU1 (3.3 V) -> PB1 (push button) and SW1 (toggle, open) in parallel -> R2 1 k -> [GPIO5]
 *   -> R3 10 k -> GND;  [GPIO2] -> R1 220 -> D1 (LED) -> GND;  [GPIO18] -> R4 1 k -> GND.
 */
export function benchCircuit(opts: { parallelPsu?: boolean } = {}): {
  doc: ProjectDocument;
  attachments: CreateSessionRequest['attachments'];
} {
  let doc = createProject({ projectId: 'prj_host', deviceId: 'd', name: 'Host', appVersion: '0' });
  let x = 0;
  const add = (type: ComponentTypeId) => {
    x += 200;
    const r = addComponent(doc, type, { x, y: 400 });
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
  const set = (id: string, key: string, v: ParamValue) => {
    const r = setParam(doc, id, key, v);
    if (!r.ok) throw new Error(r.error);
    doc = r.doc;
  };
  const r1 = add('component.resistor');
  const d1 = add('component.led');
  const r2 = add('component.resistor');
  const r3 = add('component.resistor');
  const r4 = add('component.resistor');
  const pb = add('component.push_button');
  const sw = add('component.toggle_switch');
  wire(`${r1}.b`, `${d1}.anode`);
  wire(`${d1}.cathode`, 'GND1.ref');
  wire('PSU1.positive', `${pb}.a`);
  wire('PSU1.positive', `${sw}.a`);
  wire(`${pb}.b`, `${r2}.a`);
  wire(`${sw}.b`, `${r2}.a`);
  wire(`${r2}.b`, `${r3}.a`);
  wire(`${r3}.b`, 'GND1.ref');
  wire(`${r4}.b`, 'GND1.ref');
  wire('PSU1.negative', 'GND1.ref');
  set(r1, 'resistance', { value: 220, unit: 'ohm' });
  set(r2, 'resistance', { value: 1000, unit: 'ohm' });
  set(r3, 'resistance', { value: 10_000, unit: 'ohm' });
  set(r4, 'resistance', { value: 1000, unit: 'ohm' });
  set('PSU1', 'setpointVoltage', { value: 3.3, unit: 'volt' });
  set('PSU1', 'outputEnabled', true);
  if (opts.parallelPsu) {
    // PSU2 across PSU1's output, OFF: legal until its output is switched on.
    const p2 = add('instrument.lab_psu');
    wire(`${p2}.positive`, 'PSU1.positive');
    wire(`${p2}.negative`, 'GND1.ref');
    set(p2, 'outputEnabled', false);
  }
  return {
    doc,
    attachments: [
      { gpio: 2, component: r1, terminal: 'a' },
      { gpio: 5, component: r2, terminal: 'b' },
      { gpio: 18, component: r4, terminal: 'a' },
    ],
  };
}

export function createRequest(
  sha256: string,
  extra: Partial<CreateSessionRequest> = {},
  circuit: { parallelPsu?: boolean } = {},
): CreateSessionRequest {
  const { doc, attachments } = benchCircuit(circuit);
  return {
    protocol: PROTOCOL,
    artifact: { sha256 },
    board: 'board.esp32_devkitc_wroom32',
    circuit: createSnapshot(doc),
    attachments,
    ...extra,
  };
}

/** Resolve with the first event (already logged or future) matching `pred`; reject on timeout. */
export function waitEvent(
  s: HostSession,
  pred: (e: SessionEvent) => boolean,
  timeoutMs = 10_000,
): Promise<SessionEvent> {
  const past = s.log.since(0).find(pred);
  if (past) return Promise.resolve(past);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error('timed out waiting for event'));
    }, timeoutMs);
    const off = s.log.subscribe((e) => {
      if (!pred(e)) return;
      clearTimeout(timer);
      off();
      resolve(e);
    });
  });
}

export const waitState = (s: HostSession, state: string, timeoutMs = 10_000) =>
  waitEvent(s, (e) => e.type === 'state' && e.state === state, timeoutMs);

export const serialText = (s: HostSession) =>
  s.log
    .since(0)
    .filter((e) => e.type === 'serial')
    .map((e) => Buffer.from((e as { data: string }).data, 'base64').toString())
    .join('');

/** Whether a process id is still alive (0 signal). */
export function alive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const gone = (path: string) => !existsSync(path);

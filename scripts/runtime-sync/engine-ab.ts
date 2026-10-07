/**
 * DC regression A/B (Sprint 10 runtime sync): a previous runtime's engine and this checkout's
 * engine on exactly the requests the browser sends (every example, every ESP32 pad mode, switch
 * and button state, and the recorded Sprint 8 session request), compared as JSON byte for byte.
 * The only expected differences are circuits using the Sprint 10 yellow/green LED cards (the old
 * engine refuses them). Exits 1 on any unexpected difference.
 *
 *   git worktree add --detach /tmp/old-engine c31d62e
 *   OLD_ENGINE_DIR=/tmp/old-engine npx vite-node scripts/runtime-sync/engine-ab.ts
 */
import { readFileSync } from 'node:fs';
import { createSnapshot, setParam, type ProjectDocument } from '@tbi-lab/domain';
import * as NEW from '../../packages/engine/src/index.ts';
const OLD = (await import(
  `${process.env.OLD_ENGINE_DIR}/packages/engine/src/index.ts`
)) as typeof NEW;
import { EXAMPLES_WITH_DOCUMENTS as EXAMPLES } from '../../app/src/examples/documents.ts';
import { buildSessionRequest } from '../../app/src/runtime/snapshot.ts';

type Eng = typeof NEW;
const modes = ['input', 'output-high', 'output-low'] as const;
let same = 0;
let diff = 0;
const unexpected: string[] = [];
const notes: string[] = [];

function run(E: Eng, circuit: unknown, pins: unknown, ops: (s: any) => void) {
  const s = new (E.EngineSession as any)(circuit, pins ? { pins } : undefined);
  ops(s);
  return JSON.stringify(s.solve());
}

function compare(
  name: string,
  circuit: unknown,
  pins: unknown,
  ops: (s: any) => void,
  expectSame = true,
) {
  const a = run(OLD as unknown as Eng, circuit, pins, ops);
  const b = run(NEW, circuit, pins, ops);
  if (a === b) same++;
  else {
    diff++;
    if (expectSame)
      unexpected.push(name + '\n  old ' + a.slice(0, 300) + '\n  new ' + b.slice(0, 300));
    else notes.push(name + ': old ' + a.slice(0, 160) + ' | new ' + b.slice(0, 160));
  }
}

// Local circuits (no board): every example the old engine accepts.
for (const e of EXAMPLES) {
  if (e.document.components.some((c) => c.type === 'board.esp32_devkitc_wroom32')) continue;
  const snap = createSnapshot(e.document);
  const old = JSON.parse(run(OLD as unknown as Eng, snap, undefined, () => {}));
  const unsupported = !old.ok && old.error.code === 'unsupported_component';
  if (unsupported) {
    notes.push(
      'local ' + e.id + ': old engine refuses (' + old.error.components + '), new parts: skipped',
    );
    continue;
  }
  // led-colours uses the Sprint 10 yellow and green cards: the old engine refuses them (expected).
  compare('local ' + e.id, snap, undefined, () => {}, e.id !== 'led-colours');
  // Toggle every switch and press every button.
  for (const c of e.document.components) {
    if (c.type === 'component.toggle_switch')
      for (const closed of [true, false])
        compare('local ' + e.id + ' ' + c.id + ' closed=' + closed, snap, undefined, (s) =>
          s.applyControl(c.id, { closed }, 999),
        );
    if (c.type === 'component.push_button')
      compare('local ' + e.id + ' ' + c.id + ' pressed', snap, undefined, (s) =>
        s.setMomentary(c.id, true),
      );
  }
}

// ESP32 projects: the projected circuit and pad attachments the browser sends.
const fw = { sha256: '0'.repeat(64), origin: 'program' as const };
const redOnly = (d: ProjectDocument) => {
  let doc = d;
  for (const c of d.components)
    if (c.type === 'component.led') {
      const r = setParam(doc, c.id, 'model', 'model.led.vishay_tlhr5400');
      if (r.ok) doc = r.doc;
    }
  return doc;
};
const boards = EXAMPLES.filter((e) =>
  e.document.components.some((c) => c.type === 'board.esp32_devkitc_wroom32'),
);
for (const { id, doc, expectSame } of [
  ...boards.map((e) => ({ id: e.id, doc: e.document, expectSame: e.id !== 'esp32-bench' })),
  ...boards
    .filter((e) => e.id === 'esp32-bench')
    .map((e) => ({ id: 'esp32-bench(red-only)', doc: redOnly(e.document), expectSame: true })),
]) {
  const plan = buildSessionRequest(doc, () => fw);
  if (!plan.ok) {
    unexpected.push(id + ': no request ' + JSON.stringify(plan.error));
    continue;
  }
  const { circuit, attachments } = plan.plan.request;
  const switches = doc.components.filter((c) => c.type === 'component.toggle_switch');
  const buttons = doc.components.filter((c) => c.type === 'component.push_button');
  const combos = Math.pow(3, attachments.length);
  for (let k = 0; k < combos; k++) {
    const m = attachments.map((_, i) => modes[Math.floor(k / Math.pow(3, i)) % 3]!);
    for (const closed of [false, true])
      for (const pressed of [false, true]) {
        const name = id + ' pads=' + m.join(',') + ' sw=' + closed + ' btn=' + pressed;
        compare(
          name,
          circuit,
          attachments,
          (s) => {
            attachments.forEach((a, i) => s.setPinMode(a.gpio, m[i]));
            for (const sw of switches) s.applyControl(sw.id, { closed }, 999);
            for (const b of buttons) s.setMomentary(b.id, pressed);
          },
          expectSame,
        );
      }
  }
}

// The recorded Sprint 8 runtime request (s8-qemu-tasks fixture), every pad mode.
const fx = JSON.parse(
  readFileSync(
    new URL('../../runtime/tests/fixtures/s8-input-echo-session.json', import.meta.url),
    'utf8',
  ),
).request;
for (let k = 0; k < Math.pow(3, fx.attachments.length); k++) {
  const m = fx.attachments.map(
    (_: unknown, i: number) => modes[Math.floor(k / Math.pow(3, i)) % 3]!,
  );
  compare('s8 fixture pads=' + m.join(','), fx.circuit, fx.attachments, (s) =>
    fx.attachments.forEach((a: { gpio: number }, i: number) => s.setPinMode(a.gpio, m[i])),
  );
}

console.log('identical:', same, 'different:', diff);
for (const n of notes.slice(0, 12)) console.log('NOTE', n);
if (notes.length > 12) console.log('NOTE ...', notes.length - 12, 'more');
for (const u of unexpected.slice(0, 10)) console.log('UNEXPECTED', u);
console.log('unexpected differences:', unexpected.length);
process.exit(unexpected.length ? 1 : 0);

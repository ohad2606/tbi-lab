/** Runtime R2: protocol validation, the session state machine and the bounded event log (pure). */
import { describe, expect, it } from 'vitest';
import { EventLog } from '../eventLog.js';
import { validateCommand, validateCreate } from '../protocol.js';
import { IllegalTransition, SessionStateMachine } from '../stateMachine.js';
import { createRequest } from './support.js';

describe('protocol: categories are explicit and validation is strict', () => {
  it('a mirror and a transient command are distinguished only by `category`', () => {
    expect(
      validateCommand({
        category: 'mirror',
        seq: 1,
        projectRevision: 3,
        component: 'SW1',
        control: { closed: true },
      }).ok,
    ).toBe(true);
    expect(
      validateCommand({ category: 'transient', seq: 2, action: 'press', component: 'PB1' }).ok,
    ).toBe(true);
    // Same payload shape without a category is refused, never inferred.
    expect(validateCommand({ seq: 3, action: 'press', component: 'PB1' })).toMatchObject({
      ok: false,
      error: 'category',
    });
    // A transient command cannot carry a project revision; a mirror must.
    expect(
      validateCommand({
        category: 'transient',
        seq: 4,
        action: 'press',
        component: 'PB1',
        projectRevision: 1,
      }).ok,
    ).toBe(false);
    expect(
      validateCommand({ category: 'mirror', seq: 5, component: 'SW1', control: { closed: true } })
        .ok,
    ).toBe(false);
  });

  it('refuses malformed commands', () => {
    for (const c of [
      null,
      [],
      {
        category: 'mirror',
        seq: -1,
        projectRevision: 1,
        component: 'SW1',
        control: { closed: true },
      },
      { category: 'mirror', seq: 1, projectRevision: 1, component: 'SW1', control: {} },
      {
        category: 'mirror',
        seq: 1,
        projectRevision: 1,
        component: 'SW1',
        control: { resistance: 5 },
      },
      {
        category: 'mirror',
        seq: 1,
        projectRevision: 1,
        component: 'SW1',
        control: { setpointVoltage: Infinity },
      },
      { category: 'transient', seq: 1, action: 'hold', component: 'PB1' },
      { category: 'transient', seq: 1, action: 'press', component: '../x' },
      { category: 'transient', seq: 1, action: 'press', component: 'PB1', atSimNs: '-5' },
      { category: 'transient', seq: 1, action: 'press', component: 'PB1', atSimNs: 5 },
    ]) {
      expect(validateCommand(c).ok, JSON.stringify(c)).toBe(false);
    }
  });

  it('a create request names firmware only by sha256; never a path or executable', () => {
    const good = createRequest('c'.repeat(64));
    expect(validateCreate(good).ok).toBe(true);
    expect(validateCreate({ ...good, artifact: { sha256: 'C'.repeat(64) } }).ok).toBe(false);
    expect(validateCreate({ ...good, artifact: { sha256: 'c'.repeat(64), path: '/x' } }).ok).toBe(
      false,
    );
    expect(validateCreate({ ...good, qemu: '/bin/sh' }).ok).toBe(false);
    expect(validateCreate({ ...good, board: 'board.esp32c3' }).ok).toBe(false);
    expect(validateCreate({ ...good, commandQuantumUs: 1 }).ok).toBe(false);
  });
});

describe('session state machine', () => {
  it('follows creating -> ready -> running -> stopping -> ended', () => {
    const m = new SessionStateMachine();
    m.to('ready');
    m.to('running');
    m.to('stopping');
    m.to('ended', 'stopped');
    expect(m.history.map((h) => h.state)).toEqual([
      'creating',
      'ready',
      'running',
      'stopping',
      'ended',
    ]);
    expect(m.reason).toBe('stopped');
  });

  it('terminal states are final and need a reason; ambiguous moves are refused', () => {
    const m = new SessionStateMachine();
    expect(() => m.to('running')).toThrow(IllegalTransition); // must be prepared first
    m.to('ready');
    m.to('running');
    expect(() => m.to('ended', 'stopped')).toThrow(IllegalTransition); // via stopping
    expect(() => m.to('failed')).toThrow(/reason/);
    m.to('failed', 'runtime_crashed');
    for (const s of ['creating', 'ready', 'running', 'stopping', 'ended', 'failed'] as const) {
      expect(m.can(s)).toBe(false);
    }
  });
});

describe('event log', () => {
  it('assigns strictly increasing seq and replays from a given point', () => {
    const log = new EventLog(10);
    for (let i = 0; i < 5; i++)
      log.append({ type: 'diagnostic', simNs: String(i), severity: 'warning', code: 'x' });
    expect(log.since(0).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(log.since(3).map((e) => e.seq)).toEqual([4, 5]);
  });

  it('is bounded; a client behind the window gets a resync marker, never a silent gap', () => {
    const log = new EventLog(3);
    for (let i = 0; i < 10; i++)
      log.append({ type: 'diagnostic', simNs: null, severity: 'warning', code: 'x' });
    expect(log.size).toBe(3);
    const replay = log.since(2);
    expect(replay[0]).toMatchObject({ type: 'resync', missed: 5 });
    expect(replay.slice(1).map((e) => e.seq)).toEqual([8, 9, 10]);
  });
});

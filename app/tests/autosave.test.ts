import { describe, expect, it } from 'vitest';
import { createProject, type ProjectDocument } from '@tbi-lab/domain';
import { Autosave, type SaveState } from '../src/persistence/autosave.js';
import type { ProjectStorage } from '../src/persistence/store.js';

function doc(name: string): ProjectDocument {
  return createProject({ projectId: 'prj_a1', deviceId: 'd', name, appVersion: '0' });
}

class MemoryStorage implements ProjectStorage {
  saved: ProjectDocument[] = [];
  failNext = 0;
  async save(d: ProjectDocument) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('QuotaExceededError');
    }
    this.saved.push(d);
  }
  async add(d: ProjectDocument) {
    await this.save(d);
  }
  async delete() {}
  async load() {
    return undefined;
  }
  async list() {
    return [];
  }
  async getOrCreateDeviceId() {
    return 'd';
  }
}

/** A manual timer: nothing fires until the test says so. */
function manualTimer() {
  let pending: (() => void) | null = null;
  return {
    schedule: (h: () => void) => ((pending = h), 1),
    cancel: () => void (pending = null),
    fire: () => {
      const h = pending;
      pending = null;
      h?.();
    },
  };
}

describe('Autosave', () => {
  it('coalesces a burst of edits into one write of the latest document', async () => {
    const storage = new MemoryStorage();
    const timer = manualTimer();
    const a = new Autosave(storage, timer);
    for (let i = 0; i < 25; i++) a.queue(doc(`v${i}`));
    expect(storage.saved).toHaveLength(0);
    timer.fire();
    await a.flush();
    expect(a.writeCount).toBe(1);
    expect(storage.saved.map((d) => d.name)).toEqual(['v24']);
  });

  it('reports saving -> saved', async () => {
    const storage = new MemoryStorage();
    const timer = manualTimer();
    const a = new Autosave(storage, timer);
    const states: SaveState[] = [];
    a.onState((s) => states.push(s));
    a.queue(doc('x'));
    expect(a.state).toBe('saving');
    expect(a.dirty).toBe(true);
    await a.flush();
    expect(a.state).toBe('saved');
    expect(a.dirty).toBe(false);
    expect(states).toEqual(['saving', 'saved']);
  });

  it('never drops the document on failure: reports error, then retries it', async () => {
    const storage = new MemoryStorage();
    storage.failNext = 1;
    const a = new Autosave(storage, manualTimer());
    a.queue(doc('important'));
    await a.flush();
    expect(a.state).toBe('error');
    expect(a.dirty).toBe(true);
    expect(storage.saved).toHaveLength(0);
    await a.retry();
    expect(a.state).toBe('saved');
    expect(storage.saved.map((d) => d.name)).toEqual(['important']);
  });

  it('after a failure, a newer edit supersedes the failed one', async () => {
    const storage = new MemoryStorage();
    storage.failNext = 1;
    const a = new Autosave(storage, manualTimer());
    a.queue(doc('old'));
    await a.flush();
    a.queue(doc('new'));
    await a.flush();
    expect(storage.saved.map((d) => d.name)).toEqual(['new']);
    expect(a.state).toBe('saved');
  });
});

// Sprint 13 Task D (overnight audit, H2): one pending slot for all projects meant a failed write
// of project A was silently dropped by the first change to project B, and B's successful write
// then cleared the error indicator.
describe('Autosave across projects (no silent loss)', () => {
  const docOf = (projectId: string, name: string) =>
    createProject({ projectId, deviceId: 'd', name, appVersion: '0' });

  it('a failed write of A survives a change to B; the error stays until A is written', async () => {
    const storage = new MemoryStorage();
    const a = new Autosave(storage, manualTimer());
    storage.failNext = 1;
    a.queue(docOf('prj_a', 'A edited'));
    await a.flush();
    expect(a.state).toBe('error');
    a.queue(docOf('prj_b', 'B edited'));
    await a.flush();
    // B was written; A was retried in the same flush and written too (the store works again).
    expect(storage.saved.map((d) => d.name).sort()).toEqual(['A edited', 'B edited']);
    expect(a.state).toBe('saved');
    expect(a.dirty).toBe(false);
  });

  it('while A keeps failing, a successful write of B does not report "saved"', async () => {
    const storage = new MemoryStorage();
    const a = new Autosave(storage, manualTimer());
    storage.failNext = 2; // A's first write and its retry fail; B succeeds.
    a.queue(docOf('prj_a', 'A edited'));
    await a.flush();
    a.queue(docOf('prj_b', 'B edited'));
    await a.flush();
    expect(storage.saved.map((d) => d.name)).toEqual(['B edited']);
    expect(a.state).toBe('error');
    expect(a.dirty).toBe(true);
    await a.retry();
    expect(storage.saved.map((d) => d.name)).toEqual(['B edited', 'A edited']);
    expect(a.state).toBe('saved');
  });

  it('a newer change of the same project still supersedes its failed one; discard drops only that project', async () => {
    const storage = new MemoryStorage();
    const a = new Autosave(storage, manualTimer());
    storage.failNext = 1;
    a.queue(docOf('prj_a', 'A v1'));
    await a.flush();
    a.queue(docOf('prj_a', 'A v2'));
    a.queue(docOf('prj_b', 'B v1'));
    await a.discard('prj_b');
    await a.flush();
    expect(storage.saved.map((d) => d.name)).toEqual(['A v2']);
    expect(a.state).toBe('saved');
  });
});

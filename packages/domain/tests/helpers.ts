import { createProject, type Clock, type ProjectDocument } from '../src/index.js';

export const fixedClock: Clock = { now: () => new Date('2026-09-22T12:00:00.000Z') };

export function newDoc(): ProjectDocument {
  return createProject({
    projectId: 'prj_test0001',
    deviceId: 'device-test',
    name: 'Test bench',
    appVersion: '0.1.0',
    clock: fixedClock,
  });
}

export function must<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`edit failed: ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}

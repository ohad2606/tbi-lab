/**
 * Sprint 8 Phase 4: the app turns each stable policy refusal of the backends into its own error
 * (and so its own localized message), not a generic "busy".
 */
import { describe, expect, it } from 'vitest';
import { BuildClient, BuildTransportError } from '../src/programs/client.js';
import { RuntimeClient, RuntimeTransportError } from '../src/runtime/client.js';

const reply = (status: number, body: unknown): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

async function buildError(status: number, error: string) {
  const client = new BuildClient({ base: '/build', fetch: reply(status, { error }) });
  return client.build('esp32-arduino-3.3.12', [{ name: 'sketch.ino', text: 'x' }]).then(
    () => null,
    (e: BuildTransportError) => e.code,
  );
}

describe('policy refusals in the app', () => {
  it('build refusals map to their own codes', async () => {
    expect(await buildError(429, 'build_quota')).toBe('quota');
    expect(await buildError(429, 'build_cooldown')).toBe('cooldown');
    expect(await buildError(429, 'rate_limited')).toBe('rate_limited');
    expect(await buildError(403, 'storage_quota')).toBe('storage_quota');
    expect(await buildError(503, 'builder_busy')).toBe('busy');
    expect(await buildError(503, 'memory_pressure')).toBe('busy');
  });

  it('a disabled prebuilt capability is its own error', async () => {
    const client = new BuildClient({
      base: '/build',
      fetch: reply(403, { error: 'capability_disabled' }),
    });
    await expect(client.uploadPrebuilt(new ArrayBuffer(8))).rejects.toMatchObject({
      code: 'capability_disabled',
    });
  });

  it('session refusals map to session_quota, rate_limited, or busy for host capacity', async () => {
    const create = async (status: number, error: string) => {
      const client = new RuntimeClient({ base: '/runtime', fetch: reply(status, { error }) });
      return client.create({} as never).then(
        () => null,
        (e: RuntimeTransportError) => e.code,
      );
    };
    expect(await create(429, 'session_quota')).toBe('session_quota');
    expect(await create(429, 'rate_limited')).toBe('rate_limited');
    expect(await create(503, 'runtime_capacity')).toBe('busy');
  });
});

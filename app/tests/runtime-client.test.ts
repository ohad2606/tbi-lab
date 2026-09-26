/**
 * Sprint 6: the browser R2 client against the REAL Session Host code (SessionHost + http.ts +
 * EventLog) with the R2 fake runtime process: no QEMU, routine CI.
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionEvent } from '../../runtime/host/protocol.js';
import type { SessionHost } from '../../runtime/host/host.js';
import { createHttpServer } from '../../runtime/host/http.js';
import { createRequest, fakeHost } from '../../runtime/host/tests/support.js';
import {
  RuntimeClient,
  RuntimeTransportError,
  type RuntimeSession,
  type StreamStatus,
} from '../src/runtime/client.js';

let open: { host: SessionHost; server: Server }[] = [];
afterEach(async () => {
  for (const { host, server } of open) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await host.shutdown();
  }
  open = [];
});

async function serve(over = {}) {
  const { host, art } = fakeHost('normal', over);
  const server = createHttpServer(host);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  open.push({ host, server });
  return { host, server, art, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** Collect a session's stream; resolve helpers wait for conditions on it. */
function collect(session: RuntimeSession) {
  const events: SessionEvent[] = [];
  const statuses: StreamStatus[] = [];
  session.stream(
    (e) => events.push(e),
    (s) => statuses.push(s),
  );
  const until = async (pred: () => boolean, ms = 10_000) => {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { events, statuses, until };
}

const serialOf = (events: SessionEvent[]) =>
  events
    .filter((e) => e.type === 'serial')
    .map((e) => Buffer.from((e as { data: string }).data, 'base64').toString())
    .join('');

describe('RuntimeClient against the real Session Host transport', () => {
  it('one-shot lifecycle with ordered, contiguous events; the token never appears in a URL', async () => {
    const { base, art } = await serve();
    const urls: string[] = [];
    const client = new RuntimeClient({
      base,
      fetch: (input, init) => {
        urls.push(String(input));
        return fetch(input, init);
      },
    });
    const s = await client.create(createRequest(art.sha256));
    expect(s.created.state).toBe('ready');
    const c = collect(s);
    await s.run();
    await c.until(() => serialOf(c.events).includes('BOOT 1'));
    await s.stop();
    await c.until(() => c.events.some((e) => e.type === 'state' && e.state === 'ended'));
    expect(c.events.map((e) => e.seq)).toEqual(c.events.map((_, i) => i + 1)); // contiguous
    const states = c.events
      .filter((e) => e.type === 'state')
      .map((e) => (e as { state: string }).state);
    expect(states).toEqual(['creating', 'ready', 'running', 'stopping', 'ended']);
    for (const u of urls) expect(u).not.toContain('token');
    // A new session is fresh: its own id, its own boot.
    const s2 = await client.create(createRequest(art.sha256));
    expect(s2.id).not.toBe(s.id);
    await s2.terminate();
  });

  it('mirrors carry revisions (accepted / stale / duplicate); transients carry none', async () => {
    const { base, art } = await serve();
    const req = createRequest(art.sha256);
    const sw = req.circuit.components.find((x) => x.type === 'component.toggle_switch')!.id;
    const pb = req.circuit.components.find((x) => x.type === 'component.push_button')!.id;
    const rev = req.circuit.projectRevision;
    const s = await new RuntimeClient({ base }).create(req);
    const c = collect(s);
    await s.run();
    await c.until(() => serialOf(c.events).includes('BOOT'));
    const ok = await s.command({
      category: 'mirror',
      projectRevision: rev + 1,
      component: sw,
      control: { closed: true },
    });
    expect(ok).toMatchObject({ accepted: true, revisions: { accepted: rev + 1 } });
    const dup = await s.command({
      category: 'mirror',
      projectRevision: rev + 1,
      component: sw,
      control: { closed: false },
    });
    expect(dup).toMatchObject({ accepted: false, reason: 'duplicate_revision' });
    const stale = await s.command({
      category: 'mirror',
      projectRevision: rev,
      component: sw,
      control: { closed: false },
    });
    expect(stale).toMatchObject({ accepted: false, reason: 'stale_revision' });
    const press = await s.command({ category: 'transient', action: 'press', component: pb });
    expect(press).toMatchObject({ accepted: true });
    expect(press.revisions).toBeUndefined();
    await c.until(() =>
      c.events.some(
        (e) => e.type === 'command' && e.result === 'applied' && e.projectRevision === rev + 1,
      ),
    );
    await s.terminate();
  });

  it('a dropped stream resumes with Last-Event-ID: nothing missed, nothing repeated', async () => {
    const { base, art, server } = await serve();
    const s = await new RuntimeClient({ base }).create(createRequest(art.sha256));
    const c = collect(s);
    await s.run();
    await c.until(() => c.events.length > 8);
    server.closeAllConnections(); // the transport drops (the session keeps running)
    await c.until(() => c.statuses.some((x) => x.kind === 'reconnecting'));
    const at = c.events.length;
    await c.until(() => c.events.length > at + 5);
    expect(c.events.map((e) => e.seq)).toEqual(c.events.map((_, i) => i + 1));
    expect(c.events.some((e) => e.type === 'resync')).toBe(false);
    await s.terminate();
  });

  it('history evicted while away arrives as an explicit resync with the exact missed count', async () => {
    const { base, art, server } = await serve({ eventLogCapacity: 8 });
    let block = false;
    const client = new RuntimeClient({
      base,
      fetch: (input, init) =>
        block && String(input).endsWith('/events')
          ? Promise.reject(new TypeError('offline'))
          : fetch(input, init),
    });
    const s = await client.create(createRequest(art.sha256));
    const c = collect(s);
    await s.run();
    await c.until(() => c.events.length > 3);
    block = true;
    server.closeAllConnections();
    await new Promise((r) => setTimeout(r, 1000)); // the fake runtime keeps producing events
    const seen = s.resumeFrom;
    block = false;
    await c.until(() => c.events.some((e) => e.type === 'resync'));
    const r = c.events.find((e) => e.type === 'resync')! as SessionEvent & { missed: number };
    expect(r.seq).toBeGreaterThan(seen + 1);
    expect(r.missed).toBe(r.seq - seen);
    // After the marker the stream is contiguous again.
    const after = c.events.slice(c.events.indexOf(r));
    expect(after.map((e) => e.seq)).toEqual(after.map((_, i) => r.seq + i));
    await s.terminate();
  });

  it('typed errors: busy host, unknown session, non-JSON (proxy HTML) and create refusal', async () => {
    const { base, art } = await serve({ maxSessions: 1 });
    const client = new RuntimeClient({ base });
    const a = await client.create(createRequest(art.sha256));
    await expect(client.create(createRequest(art.sha256))).rejects.toMatchObject({ code: 'busy' });
    await a.terminate();
    await expect(a.status()).resolves.toMatchObject({ state: 'ended' });
    await expect(client.create({ nonsense: true } as never)).rejects.toMatchObject({
      code: 'refused',
    });
    const html = new RuntimeClient({
      base,
      fetch: async () => new Response('<html>login</html>', { status: 200 }),
    });
    await expect(html.create(createRequest(art.sha256))).rejects.toBeInstanceOf(
      RuntimeTransportError,
    );
    await expect(html.create(createRequest(art.sha256))).rejects.toMatchObject({
      code: 'protocol',
    });
    const down = new RuntimeClient({ base: 'http://127.0.0.1:9' });
    await expect(down.create(createRequest(art.sha256))).rejects.toMatchObject({
      code: 'unreachable',
    });
  });
});

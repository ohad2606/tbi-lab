/**
 * Fake R2 Session Host for ROUTINE browser tests (Sprint 6). No QEMU.
 *
 * Transport and protocol are the REAL ones: requests are served by runtime/host/http.ts (auth,
 * body limits, SSE, Last-Event-ID resume, 400/409 resume validation), with the real EventLog
 * (bounded, resync markers) and the real validators of `tbi-lab.session/1`. The electrical side
 * is the REAL production engine with the MCU pad attachments. Only the MCU is scripted: the two
 * curated S6 firmware behaviours, advanced in 10 ms simulation steps paced by wall time.
 *
 *   PORT (default 7499). Test controls (never part of the product protocol):
 *     POST /__test/drop-streams          close every connection (clients reconnect)
 *     POST /__test/end-all?reason=R      end every live session with R (e.g. lease_expired)
 *     POST /__test/fail-next-create?status=N   answer the next create with HTTP N
 *     POST /__test/capacity?n=N          event-log capacity for new sessions
 *     POST /__test/pause?ms=N            stop emitting for N ms (events pile up server-side)
 *     GET  /__test/sessions              live/terminal counts
 */
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { EngineSession, interpretDigitalInput, type DigitalLevel } from '@tbi-lab/engine';
import { FIRMWARE_ARTIFACTS } from '@tbi-lab/domain';
import { createHttpServer } from '../../../runtime/host/http.js';
import { EventLog } from '../../../runtime/host/eventLog.js';
import {
  validateCommand,
  validateCreate,
  type CreateSessionRequest,
  type SessionCommand,
  type SessionState,
} from '../../../runtime/host/protocol.js';
import type { SessionHost } from '../../../runtime/host/host.js';

const PORT = Number(process.env.PORT ?? 7499);
const STEP_NS = 10_000_000n;
const GPIO_PROOF = FIRMWARE_ARTIFACTS.find((f) => f.id === 'tbi-gpio-proof')!.sha256;
const BANKS = FIRMWARE_ARTIFACTS.find((f) => f.id === 'tbi-banks')!.sha256;

let capacity = 4096;
let failNextCreate: number | null = null;
let pausedUntil = 0;

class FakeSession {
  readonly id = randomBytes(16).toString('hex');
  readonly token = randomBytes(24).toString('base64url');
  readonly tokenHash = createHash('sha256').update(this.token).digest('hex');
  readonly log = new EventLog(capacity);
  streams = 0;
  lastActivity = performance.now();
  state: SessionState = 'creating';
  reason: string | null = null;
  private simNs = 0n;
  private timer: ReturnType<typeof setInterval> | null = null;
  private engine: EngineSession | null = null;
  private inputs = new Map<number, DigitalLevel>();
  private outputs = new Map<number, 0 | 1>();
  private window = new Map<number, { drive: 0 | 1; level: 0 | 1; transitions: number }>();
  private serial = '';
  private lastElectrical = '';
  private queue: SessionCommand[] = [];
  private lastSeq = 0;
  private accepted: number;
  private applied: number;
  private step = 0;

  constructor(readonly req: CreateSessionRequest) {
    this.accepted = this.applied = req.circuit.projectRevision;
    this.emitState();
    if (req.artifact.sha256 !== GPIO_PROOF && req.artifact.sha256 !== BANKS) {
      this.end('failed', 'artifact_unknown');
      return;
    }
    this.engine = new EngineSession(req.circuit, { pins: req.attachments });
    const first = this.engine.solve();
    if (!first.ok) {
      this.end('failed', 'electrical_error', first.error);
      return;
    }
    this.to('ready');
  }

  private emitState(detail?: unknown) {
    this.log.append({
      type: 'state',
      simNs: null,
      state: this.state,
      ...(this.reason ? { reason: this.reason as never } : {}),
      ...(detail !== undefined ? { detail } : {}),
    });
  }
  private to(s: SessionState) {
    this.state = s;
    this.emitState();
  }
  end(state: 'ended' | 'failed', reason: string, detail?: unknown) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.state === 'running') this.to('stopping');
    this.state = state;
    this.reason = reason;
    this.emitState(detail);
  }
  status() {
    return {
      sessionId: this.id,
      state: this.state,
      reason: this.reason,
      simNs: this.simNs.toString(),
      lastEventSeq: this.log.lastSeq,
      createdAt: new Date().toISOString(),
      endedAt: null,
      runtime: { pid: null, outcome: null },
      revisions: {
        snapshot: this.req.circuit.projectRevision,
        accepted: this.accepted,
        applied: this.applied,
      },
    };
  }
  run(): { ok: true } | { ok: false; error: string } {
    if (this.state !== 'ready') return { ok: false, error: 'not ready' };
    this.to('running');
    this.solveAndInject();
    this.timer = setInterval(() => this.tick(), 10);
    return { ok: true };
  }
  stop() {
    if (this.state === 'ready') return this.end('ended', 'stopped');
    if (this.state === 'running') this.end('ended', 'stopped');
  }
  terminate(reason = 'terminated') {
    if (this.state === 'ended' || this.state === 'failed') return;
    this.end('ended', reason);
  }
  submit(c: SessionCommand) {
    const reject = (reason: string) => {
      this.log.append({
        type: 'command',
        simNs: this.simNs.toString(),
        commandSeq: c.seq,
        result: 'rejected',
        reason: reason as never,
        ...(c.category === 'mirror' ? { projectRevision: c.projectRevision } : {}),
      });
      return {
        accepted: false,
        reason,
        ...(c.category === 'mirror' ? { revisions: this.status().revisions } : {}),
      };
    };
    if (c.seq <= this.lastSeq) return reject('duplicate');
    this.lastSeq = c.seq;
    if (this.state !== 'running' && this.state !== 'ready') return reject('not_running');
    if (!this.req.circuit.components.some((x) => x.id === c.component))
      return reject('unknown_component');
    if (c.category === 'mirror') {
      if (c.projectRevision < this.accepted) return reject('stale_revision');
      if (c.projectRevision === this.accepted) return reject('duplicate_revision');
      this.accepted = c.projectRevision;
    }
    this.queue.push(c);
    return {
      accepted: true,
      ...(c.category === 'mirror' ? { revisions: this.status().revisions } : {}),
    };
  }

  // ---- scripted MCU + real engine --------------------------------------------------------
  private drive(gpio: number, level: 0 | 1) {
    if (this.outputs.get(gpio) === level) return;
    this.outputs.set(gpio, level);
    const w = this.window.get(gpio);
    this.window.set(gpio, { drive: 1, level, transitions: (w?.transitions ?? 0) + 1 });
    if (this.req.attachments.some((a) => a.gpio === gpio)) {
      this.engine!.setPinMode(gpio, level ? 'output-high' : 'output-low');
      this.solveAndInject();
    }
  }
  private solveAndInject() {
    const out = this.engine!.solve();
    if (!out.ok) return this.end('failed', 'electrical_error', out.error);
    for (const p of out.pins ?? []) {
      if (this.outputs.has(p.gpio)) continue;
      const next = interpretDigitalInput(p.voltage, this.inputs.get(p.gpio) ?? 0);
      if (this.inputs.get(p.gpio) !== next) this.inputs.set(p.gpio, next);
    }
    this.latest = out;
  }
  private latest: ReturnType<EngineSession['solve']> | null = null;
  private firmware() {
    const t = Number(this.simNs / 1_000_000n); // ms
    if (this.req.artifact.sha256 === GPIO_PROOF) {
      if (this.step === 0) this.serial += 'TBI-ARDUINO-READY\r\n';
      const phase = t % 800;
      if (phase === 0) this.drive(2, 1);
      if (phase === 200) this.drive(18, 1);
      if (phase === 400) this.drive(2, 0);
      if (phase === 600) {
        this.drive(18, 0);
      }
      if (phase === 790) this.serial += `IN=${this.inputs.get(5) ?? 0}\r\n`;
    } else {
      if (this.step === 0) this.serial += 'TBI-BANKS-READY\r\nTBI-BANKS-SWEEP-DONE\r\n';
      if (this.step === 0) this.drive(4, 0);
      const v34 = (this.inputs.get(34) ?? 0) as 0 | 1;
      if (this.outputs.get(4) !== v34) {
        this.drive(4, v34);
        this.serial += `ECHO34=${v34}\r\n`;
      }
    }
  }
  private tick() {
    if (Date.now() < pausedUntil) return;
    if (this.state !== 'running') return;
    this.simNs += STEP_NS;
    for (const c of this.queue.splice(0)) {
      const ack = (result: 'applied' | 'rejected') =>
        this.log.append({
          type: 'command',
          simNs: this.simNs.toString(),
          commandSeq: c.seq,
          result,
          ...(c.category === 'mirror' ? { projectRevision: c.projectRevision } : {}),
        });
      if (c.category === 'mirror') {
        const err = this.engine!.applyControl(c.component, c.control, c.projectRevision);
        if (err) {
          ack('rejected');
          return this.end('failed', 'mirror_failed');
        }
        this.applied = c.projectRevision;
      } else if (this.engine!.setMomentary(c.component, c.action === 'press')) {
        ack('rejected');
        continue;
      }
      ack('applied');
      this.solveAndInject();
    }
    this.firmware();
    this.step++;
    // Publish the window: gpio, then the operating point if it changed, then serial.
    const t = this.simNs.toString();
    if (this.window.size) {
      const changes = [...this.window.entries()]
        .sort(([a], [b]) => a - b)
        .map(([gpio, s]) => ({ gpio, ...s }));
      this.window.clear();
      this.log.append({ type: 'gpio', simNs: t, changes });
    }
    if (this.latest) {
      const json = JSON.stringify(this.latest);
      if (json !== this.lastElectrical) {
        this.lastElectrical = json;
        this.log.append({ type: 'electrical', simNs: t, outcome: this.latest });
      }
    }
    if (this.serial) {
      this.log.append({
        type: 'serial',
        simNs: t,
        data: Buffer.from(this.serial).toString('base64'),
      });
      this.serial = '';
    }
  }
}

const sessions = new Map<string, FakeSession>();
const host = {
  config: { maxRequestBytes: 1024 * 1024 },
  create(body: unknown) {
    if (failNextCreate) {
      const status = failNextCreate;
      failNextCreate = null;
      return { ok: false, status, error: 'injected' };
    }
    const v = validateCreate(body);
    if (!v.ok) return { ok: false, status: 400, error: v.error };
    const s = new FakeSession(v.value);
    sessions.set(s.id, s);
    return { ok: true, value: { session: s } };
  },
  get(id: string, token: string | null) {
    const s = sessions.get(id);
    if (!s || token === null) return { ok: false, status: 404, error: 'no such session' };
    const given = createHash('sha256').update(token).digest();
    const want = Buffer.from(s.tokenHash, 'hex');
    if (given.length !== want.length || !timingSafeEqual(given, want))
      return { ok: false, status: 404, error: 'no such session' };
    s.lastActivity = performance.now();
    return { ok: true, value: s };
  },
  command(s: FakeSession, body: unknown) {
    const v = validateCommand(body);
    if (!v.ok) return { ok: false, status: 400, error: v.error };
    return { ok: true, value: s.submit(v.value) };
  },
  async terminate(s: FakeSession) {
    s.terminate();
  },
  health() {
    const out: Record<string, number> = {};
    for (const s of sessions.values()) out[s.state] = (out[s.state] ?? 0) + 1;
    return out;
  },
};

const inner = createHttpServer(host as unknown as SessionHost);
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://fake.invalid');
  if (!url.pathname.startsWith('/__test/')) return inner.emit('request', req, res);
  const reply = (body: unknown) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  switch (url.pathname) {
    case '/__test/drop-streams':
      reply({ ok: true });
      setTimeout(() => server.closeAllConnections(), 10);
      return;
    case '/__test/end-all':
      for (const s of sessions.values())
        s.terminate(url.searchParams.get('reason') ?? 'terminated');
      return reply({ ok: true });
    case '/__test/fail-next-create':
      failNextCreate = Number(url.searchParams.get('status') ?? 500);
      return reply({ ok: true });
    case '/__test/capacity':
      capacity = Number(url.searchParams.get('n') ?? 4096);
      return reply({ ok: true });
    case '/__test/pause':
      pausedUntil = Date.now() + Number(url.searchParams.get('ms') ?? 0);
      return reply({ ok: true });
    case '/__test/sessions':
      return reply(host.health());
    default:
      res.writeHead(404).end();
  }
});
server.listen(PORT, '127.0.0.1', () => process.stdout.write(`fake session host on ${PORT}\n`));

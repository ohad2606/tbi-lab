/**
 * Host side of the QEMU GPIO bridge protocol.
 *
 * Speaks the line protocol implemented by `qemu-patch/tbi_gpio_bridge.c`:
 *   QEMU -> host   O <pin> <level>
 *   host -> QEMU   I <pin> <level>
 */

import { Socket } from 'node:net';

export type DigitalLevel = 0 | 1;

export interface PinEvent {
  pin: number;
  level: DigitalLevel;
}

export interface GpioLink {
  onOutputChange(handler: (event: PinEvent) => void): void;
  setInput(pin: number, level: DigitalLevel): void;
}

export class QemuGpioLink implements GpioLink {
  private socket: Socket | null = null;
  private buffer = '';
  private handlers: Array<(event: PinEvent) => void> = [];
  /** Every output transition seen, in order. Useful evidence in tests. */
  readonly received: PinEvent[] = [];

  async connect(port: number, host = '127.0.0.1', timeoutMs = 15_000): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new Socket();
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`GPIO link connect timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.connect(port, host, () => {
        clearTimeout(timer);
        this.socket = socket;
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => this.ingest(chunk));
        resolve();
      });
    });
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.handleLine(line);
      index = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    const match = /^O\s+(\d+)\s+([01])$/.exec(line);
    if (!match) return;
    const event: PinEvent = { pin: Number(match[1]), level: Number(match[2]) as DigitalLevel };
    this.received.push(event);
    for (const handler of this.handlers) handler(event);
  }

  onOutputChange(handler: (event: PinEvent) => void): void {
    this.handlers.push(handler);
  }

  setInput(pin: number, level: DigitalLevel): void {
    if (!this.socket) throw new Error('GPIO link is not connected');
    this.socket.write(`I ${pin} ${level}\n`);
  }

  /** Resolve once a matching output event arrives, or reject on timeout. */
  waitForOutput(pin: number, level: DigitalLevel, timeoutMs = 10_000): Promise<PinEvent> {
    const existing = this.received.find((e) => e.pin === pin && e.level === level);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for GPIO ${pin} = ${level}`)),
        timeoutMs,
      );
      this.onOutputChange((event) => {
        if (event.pin === pin && event.level === level) {
          clearTimeout(timer);
          resolve(event);
        }
      });
    });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}

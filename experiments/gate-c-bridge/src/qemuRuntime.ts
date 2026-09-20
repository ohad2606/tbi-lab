/**
 * Spawns the classic-ESP32 QEMU runtime and exposes its serial REPL and GPIO bridge.
 *
 * Test-harness code for Sprint 0 feasibility work. Not product code.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { Socket } from 'node:net';
import { existsSync } from 'node:fs';
import { QemuGpioLink } from './qemuLink.js';

export interface RuntimeOptions {
  qemuBinary: string;
  flashImage: string;
  /**
   * Output pins the board itself already wires to something (display, servo, buttons).
   * The bridge must not hijack those. Bit N set => skip output pin N.
   */
  ignoreMask?: number;
  bootTimeoutMs?: number;
}

/** Find a free-ish port triple. Ports are chosen high and randomised to avoid collisions. */
function pickPorts(): { serial: number; gpio: number; monitor: number } {
  const base = 21000 + Math.floor(Math.random() * 20000);
  return { serial: base, gpio: base + 1, monitor: base + 2 };
}

export class Esp32Runtime {
  private process: ChildProcess | null = null;
  private serial: Socket | null = null;
  private serialBuffer = '';
  readonly link = new QemuGpioLink();
  readonly stderr: string[] = [];
  bootLog = '';

  private constructor(private readonly options: RuntimeOptions) {}

  static async start(options: RuntimeOptions): Promise<Esp32Runtime> {
    const runtime = new Esp32Runtime(options);
    await runtime.launch();
    return runtime;
  }

  private async launch(): Promise<void> {
    const { qemuBinary, flashImage } = this.options;
    if (!existsSync(qemuBinary)) throw new Error(`QEMU binary not found: ${qemuBinary}`);
    if (!existsSync(flashImage)) throw new Error(`flash image not found: ${flashImage}`);

    const ports = pickPorts();
    const ignoreMask = this.options.ignoreMask ?? 0;

    this.process = spawn(qemuBinary, [
      '-machine', 'esp32',
      '-display', 'none',
      '-drive', `file=${flashImage},if=mtd,format=raw`,
      // `server` without `nowait`: QEMU blocks until we attach, so the mask-ROM banner
      // and bootloader output are captured instead of being lost before we connect.
      '-serial', `tcp::${ports.serial},server`,
      '-monitor', `tcp::${ports.monitor},server,nowait`,
      '-chardev', `socket,id=tbigpio,host=127.0.0.1,port=${ports.gpio},server=on,wait=off`,
      '-device', `tbi-gpio-bridge,chardev=tbigpio,ignore-mask=${ignoreMask}`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    this.process.stderr?.on('data', (d: Buffer) => this.stderr.push(d.toString()));
    this.process.stdout?.on('data', (d: Buffer) => this.stderr.push(d.toString()));

    // Give QEMU a moment to open its listening sockets.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (this.process.exitCode !== null) {
      throw new Error(`QEMU exited immediately (${this.process.exitCode}): ${this.stderr.join('')}`);
    }

    // Serial first: the guest is held until it attaches, so nothing is missed.
    await this.connectSerial(ports.serial);
    await this.link.connect(ports.gpio);
    await this.waitForPrompt(this.options.bootTimeoutMs ?? 120_000);
  }

  private async connectSerial(port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new Socket();
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('serial connect timed out'));
      }, 15_000);
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.connect(port, '127.0.0.1', () => {
        clearTimeout(timer);
        this.serial = socket;
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => {
          this.serialBuffer += chunk;
          this.bootLog += chunk;
        });
        resolve();
      });
    });
  }

  private async waitForPrompt(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.serialBuffer.includes('>>>')) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`firmware did not reach a REPL prompt.\nboot log:\n${this.bootLog.slice(-1500)}`);
  }

  /** Send one REPL line and return what the firmware printed for it. */
  async repl(command: string, timeoutMs = 20_000): Promise<string> {
    if (!this.serial) throw new Error('serial is not connected');
    this.serialBuffer = '';
    this.serial.write(`${command}\r\n`);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.serialBuffer.includes('>>>')) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const lines = this.serialBuffer
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && l !== command.trim() && !l.startsWith('>>>'));
    return lines.join('\n');
  }

  /** Evaluate an expression and return it as a number. */
  async evalNumber(expression: string): Promise<number> {
    const out = await this.repl(expression);
    const value = Number(out.replace(/['"]/g, '').trim());
    if (Number.isNaN(value)) throw new Error(`expected a number from "${expression}", got: ${out}`);
    return value;
  }

  async stop(): Promise<void> {
    this.link.close();
    this.serial?.destroy();
    this.process?.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (this.process && this.process.exitCode === null) this.process.kill('SIGKILL');
  }
}

/** Paths are overridable so the harness is not tied to one machine. */
export const QEMU_BINARY =
  process.env.TBI_QEMU ?? '/home/ubuntu/tbi-tools/src/a159-qemu/build/qemu-system-xtensa';
export const FLASH_IMAGE =
  process.env.TBI_FLASH ?? '/home/ubuntu/tbi-tools/fw/flash-4mb.bin';

/**
 * GPIO 4, 16 and 27 are wired by the a159x36 TTGO board model to a display and a servo.
 * The bridge must leave those alone.
 */
export const BOARD_RESERVED_PINS_MASK = (1 << 4) | (1 << 16) | (1 << 27);

/**
 * PHASE 5 — classic-ESP32 LX6 CPU execution under QEMU compiled to WebAssembly.
 *
 * WHAT THIS IS: the same bare-metal LX6 benchmark measured natively (QEMU 10.1, same
 * patched source) run inside Chromium via QEMU's Emscripten port, on the generic `sim`
 * machine with `-cpu esp32`.
 *
 * WHAT THIS IS NOT: classic ESP32 firmware execution. There is no ESP32 ROM, no ESP32
 * peripherals and no GPIO here, because no wasm-capable QEMU contains the ESP32 machine.
 * Per the brief this does NOT count as browser-local classic ESP32, and it is not reported
 * as such. It measures whether the CPU half of that goal is fast enough to be worth porting
 * the machine half.
 *
 * Measured: payload size, cold start, first guest output, guest execution time for two
 * workload sizes (so fixed start-up cost and per-instruction cost can be separated),
 * renderer memory, CPU time, and correctness against the native/Python checksum.
 */

import { test, expect, chromium } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFile, stat, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const QEMU_DIR = process.env.TBI_QEMU_WASM_DIR ?? '/home/ubuntu/tbi-tools/src/qemu-10.1/build-wasm';
const ELF_DIR = process.env.TBI_LX6_ELF_DIR ?? join(HERE, '..', 'lx6-bench');

/** Checksums independently computed in Python (see lx6-bench commit). */
const EXPECTED: Record<string, string> = {
  'bench-2m.elf': '0x7577d9f4',
  'bench-20m.elf': '0x946faeb2',
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.elf': 'application/octet-stream',
};

let server: Server;
let baseUrl: string;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    let path: string;
    if (url.startsWith('/qemu/')) path = normalize(join(QEMU_DIR, url.slice('/qemu/'.length)));
    else if (url.startsWith('/elf/')) path = normalize(join(ELF_DIR, url.slice('/elf/'.length)));
    else path = normalize(join(HERE, url));
    // Cross-origin isolation: REQUIRED for SharedArrayBuffer, which QEMU's pthread build needs.
    const headers = {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    };
    readFile(path)
      .then((body) => {
        res.writeHead(200, { ...headers, 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
        res.end(body);
      })
      .catch(() => res.writeHead(404, headers).end());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Sum RSS (KB) and CPU ticks across all Chromium processes, from /proc. */
function chromiumUsage(): { rssKb: number; cpuTicks: number } {
  let rssKb = 0;
  let cpuTicks = 0;
  const pids = execSync("pgrep -f 'chrome-headless-shell|chromium' || true").toString().trim().split('\n').filter(Boolean);
  for (const pid of pids) {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const m = /VmRSS:\s+(\d+) kB/.exec(status);
      if (m) rssKb += Number(m[1]);
      const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ');
      cpuTicks += Number(fields[11]) + Number(fields[12]); // utime + stime
    } catch { /* process exited */ }
  }
  return { rssKb, cpuTicks };
}

async function payload(): Promise<Record<string, number>> {
  const sizes: Record<string, number> = {};
  for (const f of await readdir(QEMU_DIR)) {
    if (/^qemu-system-xtensa.*\.(js|wasm|mjs|data)$/.test(f)) sizes[f] = (await stat(join(QEMU_DIR, f))).size;
  }
  return sizes;
}

for (const elf of ['bench-2m.elf', 'bench-20m.elf']) {
  test(`LX6 benchmark under QEMU-wasm in Chromium: ${elf}`, async () => {
    test.setTimeout(3_600_000);
    const sizes = await payload();
    expect(Object.keys(sizes).length, 'QEMU wasm artifacts present').toBeGreaterThan(0);
    console.log('payload bytes:', JSON.stringify(sizes));

    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));

      await page.goto(`${baseUrl}/index.html`);
      await page.waitForFunction(() => (window as any).__ready === true);
      expect(await page.evaluate(() => crossOriginIsolated), 'page is cross-origin isolated').toBe(true);

      let peakRssKb = 0;
      const before = chromiumUsage();
      const baselineRssMb = Math.round(before.rssKb / 1024);
      const ticksBefore = await page.evaluate(() => (window as any).__tick as number);
      const sampler = setInterval(() => { peakRssKb = Math.max(peakRssKb, chromiumUsage().rssKb); }, 250);

      const result = await page.evaluate(
        async (a) => await (window as any).__run(a),
        { elfUrl: `/elf/${elf}`, args: ['-M', 'sim', '-cpu', 'esp32', '-semihosting', '-display', 'none', '-monitor', 'none', '-serial', 'none', '-kernel', '/bench.elf'] },
      );
      clearInterval(sampler);
      const after = chromiumUsage();
      const ticksAfter = await page.evaluate(() => (window as any).__tick as number);
      const clk = Number(execSync('getconf CLK_TCK').toString());

      const m = result.marks;
      const line = (result.out as string[]).find((l) => l.includes('TBI-LX6-BENCH')) ?? '';
      const checksum = /checksum=(0x[0-9a-f]{8})/.exec(line)?.[1];

      console.log(JSON.stringify({
        elf,
        checksum,
        expected: EXPECTED[elf],
        importMs: Math.round(m.importDone - m.importStart),
        importToRuntimeInitMs: m.runtimeInitialized ? Math.round(m.runtimeInitialized - m.importStart) : null,
        importToFirstOutputMs: Math.round(m.firstOutput - m.importStart),
        importToDoneMs: Math.round(m.done - m.importStart),
        baselineChromiumRssMb: baselineRssMb,
        peakChromiumRssMb: Math.round(peakRssKb / 1024),
        mainThreadTicksDuringRun: ticksAfter - ticksBefore,
        crossOriginIsolated: true,
        chromiumCpuSeconds: +((after.cpuTicks - before.cpuTicks) / clk).toFixed(2),
        stderrTail: (result.out as string[]).filter((l) => l.startsWith('[')).slice(-5),
      }, null, 2));

      expect(errors, 'page errors').toEqual([]);
      expect(checksum, 'guest computed the correct result under wasm').toBe(EXPECTED[elf]);
      // QEMU's main() runs in a pthread (PROXY_TO_PTHREAD), i.e. a Web Worker; the page's
      // own 10 ms timer loop must keep running throughout.
      expect(ticksAfter - ticksBefore, 'main thread stayed responsive').toBeGreaterThan(50);
    } finally {
      await browser.close();
    }
  });
}

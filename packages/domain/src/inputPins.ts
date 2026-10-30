/**
 * Sprint 24 (M2): the GPIOs a board's program reads as digital inputs, from its source text, for
 * the editor-time circuit check `gpio_input_floating` (checks.ts). Static and conservative: only
 * pins given as integer literals, or as simple top-level constants (`BUTTON = 34`, `const int
 * BUTTON = 34;`, `#define BUTTON 34`), are found; anything else is not reported (a check may miss
 * a pin, it never invents one).
 *
 * - MicroPython: `Pin(<pin>, Pin.IN …)` / `Pin(<pin>, mode=Pin.IN …)` (any `x.Pin` spelling).
 * - Arduino/C++: `pinMode(<pin>, INPUT)` and `digitalRead(<pin>)`.
 *
 * A pin the program also gives an internal pull (`INPUT_PULLUP`, `Pin.PULL_UP`, …) or sets as an
 * output is not reported: it is held by the chip, not floating.
 */
import type { ProgramSource } from './schema.js';

/** Source without comments; string contents blanked (names in strings are not code here). */
function strip(text: string, language: ProgramSource['language']): string {
  if (language === 'micropython')
    return text
      .replace(/("""|''')[\s\S]*?\1/g, '""')
      .replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, '""')
      .replace(/#[^\n]*/g, '');
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

function constants(code: string, language: ProgramSource['language']): Map<string, number> {
  const out = new Map<string, number>();
  const re =
    language === 'micropython'
      ? /^([A-Za-z_]\w*)\s*=\s*(\d+)\s*$/gm
      : /(?:^|[;{}\n])\s*(?:static\s+)?(?:const(?:expr)?\s+)?(?:unsigned\s+)?(?:int|uint8_t|int8_t|uint16_t|int16_t|uint32_t|int32_t|byte|short|long|size_t|gpio_num_t)\s+([A-Za-z_]\w*)\s*=\s*(\d+)\s*;|#\s*define\s+([A-Za-z_]\w*)\s+(\d+)\b/g;
  for (const m of code.matchAll(re)) {
    const name = m[1] ?? m[3];
    const value = m[2] ?? m[4];
    if (name && value) out.set(name, Number(value));
  }
  return out;
}

export function programInputPins(program: ProgramSource): number[] {
  const code = strip(program.text, program.language);
  const consts = constants(code, program.language);
  const pin = (token: string): number | null => {
    const t = token.trim();
    if (/^\d+$/.test(t)) return Number(t);
    return consts.get(t) ?? null;
  };
  const found = new Set<number>();
  const add = (token: string) => {
    const p = pin(token);
    if (p !== null && p >= 0 && p <= 39) found.add(p);
  };
  // Review M4: a pin the program gives an internal pull or makes an output is not floating.
  const held = new Set<number>();
  if (program.language === 'micropython') {
    for (const m of code.matchAll(
      /\bPin\s*\(\s*([A-Za-z_]\w*|\d+)\s*,\s*(?:mode\s*=\s*)?(?:[A-Za-z_]\w*\s*\.\s*)*Pin\s*\.\s*IN\b([^()]*)/g,
    )) {
      if (/\bPULL_(?:UP|DOWN)\b/.test(m[2]!)) {
        const p = pin(m[1]!);
        if (p !== null) held.add(p);
      } else add(m[1]!);
    }
  } else {
    for (const m of code.matchAll(
      /\bpinMode\s*\(\s*([A-Za-z_]\w*|\d+)\s*,\s*(INPUT|INPUT_PULLUP|INPUT_PULLDOWN|OUTPUT|OUTPUT_OPEN_DRAIN)\s*\)/g,
    )) {
      const p = pin(m[1]!);
      if (m[2] !== 'INPUT' && p !== null) held.add(p);
      else add(m[1]!);
    }
    for (const m of code.matchAll(/\bdigitalRead\s*\(\s*([A-Za-z_]\w*|\d+)\s*\)/g)) add(m[1]!);
  }
  return [...found].filter((p) => !held.has(p)).sort((a, b) => a - b);
}

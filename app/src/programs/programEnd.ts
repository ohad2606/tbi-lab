/**
 * Sprint 24 (M1): when a MicroPython program's main.py ends, the genuine interpreter prints, as on a
 * real board, an uncaught exception's traceback (if any) and then drops to its REPL with its banner
 * and prompt. The session keeps running (the board waits at the prompt). This reads that ending
 * from the serial output so the terminal can say so plainly.
 *
 * It is DERIVED FROM SERIAL TEXT, not from the interpreter's state: Runtime v4 reports no "program
 * ended" event. Only the interpreter's exact ending counts (the banner of this interpreter, then
 * `>>> ` as the LAST output), so ordinary prints never look like it; a program that itself prints
 * that exact text and then prints nothing more would. The notice says so. It is a hint, never a
 * session state: the session is not failed and goes on until it is stopped.
 *
 * Sample (Runtime v4, MicroPython v1.29.0, ZeroDivisionError in f() called at line 6):
 *   Traceback (most recent call last):
 *     File "main.py", line 6, in <module>
 *     File "main.py", line 4, in f
 *   ZeroDivisionError: divide by zero
 *   MicroPython v1.29.0 on 2026-08-24; Generic ESP32 module with ESP32
 *   Type "help()" for more information.
 *   >>>
 */

export type ProgramEnd =
  | {
      kind: 'error';
      /** The exception line as the interpreter printed it (`ZeroDivisionError: divide by zero`). */
      exception: string;
      /** The innermost frame in `file` (where it was raised), when the traceback names one. */
      line?: number;
      /** The traceback as printed, from its first line to the exception (technical text). */
      traceback: string[];
    }
  | { kind: 'finished' };

/** The REPL banner of the pinned interpreter and its prompt, at the very end of the output. */
const BANNER =
  /(?:^|\n)MicroPython v\d+\.\d+\.\d+[^\n]*\nType "help\(\)" for more information\.\n>>> $/;
const TRACEBACK = 'Traceback (most recent call last):';

export function micropythonProgramEnd(serial: string, file = 'main.py'): ProgramEnd | null {
  const text = serial.replace(/\r\n?/g, '\n');
  const banner = BANNER.exec(text);
  if (!banner) return null;
  const before = text.slice(0, banner.index + (banner[0].startsWith('\n') ? 1 : 0));
  const lines = before.split('\n');
  if (lines.at(-1) === '') lines.pop();
  // The traceback directly before the banner: its header, frames ("  File ..."), the exception.
  const start = lines.lastIndexOf(TRACEBACK);
  if (start < 0) return { kind: 'finished' };
  const block = lines.slice(start);
  let i = 1;
  while (i < block.length && /^ {2}File "/.test(block[i]!)) i++;
  const rest = block.slice(i);
  // The traceback ends in ONE exception line, right before the banner. (Anything after it was
  // printed by the program, which then ended normally; a multi-line message is read the same way:
  // the documented limit.)
  if (i === 1 || rest.length !== 1 || !/^[A-Za-z_][\w.]*(?::|$)/.test(rest[0]!))
    return { kind: 'finished' };
  let line: number | undefined;
  const quoted = JSON.stringify(file);
  for (const f of block.slice(1, i)) {
    const m = /^ {2}File (".*?"), line (\d+)/.exec(f);
    if (m && m[1] === quoted) line = Number(m[2]);
  }
  return {
    kind: 'error',
    exception: rest[0]!,
    ...(line !== undefined ? { line } : {}),
    traceback: block,
  };
}

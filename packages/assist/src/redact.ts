/**
 * Sprint 27: what leaves the product in a context excerpt. User code is data: comments are removed
 * (they are where text addressed to a model would hide, and they are not needed to locate a
 * fault), and so is the content of every string literal (review S27-M3/L5: Wi-Fi credentials are
 * passed positionally — WiFi.begin("net", "pw") — or hidden behind any name, and strings can carry
 * instructions as well as comments). Line structure is kept exactly so line numbers stay true.
 */

/**
 * The text with every comment blanked and every string literal's content replaced by `…`
 * (quotes kept, newlines inside kept). C/C++: `//` (continued by a trailing backslash), block
 * comments, "…" and '…' literals, but not a digit separator (1'000). MicroPython: `#`, '…', "…" and
 * triple-quoted strings (docstrings included).
 */
export function maskComments(text: string, language: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  const emptied = (q: string, body: string, close: string) =>
    q + '…' + body.replace(/[^\n]/g, '') + close;
  let out = '';
  let i = 0;
  const py = language === 'micropython';
  /** The end of a line comment starting at i (C: continued while the line ends with a backslash). */
  const lineEnd = (from: number) => {
    let end = text.indexOf('\n', from);
    while (!py && end > 0 && text[end - 1] === '\\') end = text.indexOf('\n', end + 1);
    return end < 0 ? text.length : end;
  };
  while (i < text.length) {
    const c = text[i]!;
    const two = text.slice(i, i + 2);
    const three = text.slice(i, i + 3);
    if (py && (three === '"""' || three === "'''")) {
      const end = text.indexOf(three, i + 3);
      const stop = end < 0 ? text.length : end;
      out += emptied(three, text.slice(i + 3, stop), end < 0 ? '' : three);
      i = end < 0 ? text.length : end + 3;
    } else if (
      !py &&
      c === "'" &&
      /[0-9A-Fa-f]/.test(text[i - 1] ?? '') &&
      /(?<![\w.])\d[\w.']*$/.test(text.slice(Math.max(0, i - 64), i))
    ) {
      out += c; // a C++14 digit separator, not a character literal
      i += 1;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      const closed = text[j] === c;
      out += emptied(c, text.slice(i + 1, Math.min(j, text.length)), closed ? c : '');
      i = closed ? j + 1 : j;
    } else if ((py && c === '#') || (!py && two === '//')) {
      const stop = lineEnd(i);
      out += blank(text.slice(i, stop));
      i = stop;
    } else if (!py && two === '/*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += blank(text.slice(i, stop));
      i = stop;
    } else {
      out += c;
      i += 1;
    }
  }
  return out.replace(/[ \t]+$/gm, '');
}

/** A compiler or interpreter message with every quoted literal's content removed (as excerpts). */
export function maskMessage(message: string): string {
  return message.replace(/"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?/g, (m) =>
    m[0] === "'" && m.length <= 3 ? m : `${m[0]}…${m[0]}`,
  );
}

const SECRET_NAME =
  /(pass(word|wd|phrase)?|pwd|ssid|secret|token|api_?key|apikey|auth|credential|private_?key)/i;

/** A line with any string literal blanked when the line names a credential-like identifier. */
export function redactSecrets(line: string): string {
  if (!SECRET_NAME.test(line)) return line;
  return line.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '"[redacted]"');
}

/**
 * Sprint 27: what leaves the product in a context excerpt. User code is data: comments are removed
 * (they are where text addressed to a model would hide, and they are not needed to locate a
 * fault), line structure is kept exactly so line numbers stay true, and string literals assigned
 * to credential-like names are blanked (Arduino sketches routinely embed Wi-Fi passwords).
 */

/** The text with every comment replaced by spaces; newlines (so line numbers) are kept. */
export function maskComments(text: string, language: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  let out = '';
  let i = 0;
  const py = language === 'micropython';
  while (i < text.length) {
    const c = text[i]!;
    const two = text.slice(i, i + 2);
    const three = text.slice(i, i + 3);
    if (py && (three === '"""' || three === "'''")) {
      // A triple-quoted string: kept (it may be a value), but a docstring is still data.
      const end = text.indexOf(three, i + 3);
      const stop = end < 0 ? text.length : end + 3;
      out += text.slice(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (py && c === '#') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      out += blank(text.slice(i, stop));
      i = stop;
    } else if (!py && two === '//') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
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

const SECRET_NAME =
  /(pass(word|wd|phrase)?|pwd|ssid|secret|token|api_?key|apikey|auth|credential|private_?key)/i;

/** A line with any string literal blanked when the line names a credential-like identifier. */
export function redactSecrets(line: string): string {
  if (!SECRET_NAME.test(line)) return line;
  return line.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '"[redacted]"');
}

/**
 * TBI-020 slice 4: a tiny, safe reader for the user guide's markdown subset (headings, paragraphs,
 * nested ordered/unordered lists, **bold**, `code`; HTML comments are dropped). It returns plain
 * data; the component renders it as text nodes, so nothing the file contains is ever interpreted
 * as HTML. Anything outside the subset (links, images, tags) stays literal text.
 */
export type Inline = { kind: 'text' | 'strong' | 'code'; text: string };
export interface ListItem {
  inline: Inline[];
  children: Block[];
}
export type Block =
  | { type: 'heading'; level: number; id: string; inline: Inline[]; text: string }
  | { type: 'p'; inline: Inline[] }
  | { type: 'list'; ordered: boolean; items: ListItem[] };

const TOKEN = /(`[^`]+`|\*\*[^*]+\*\*)/;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  for (const part of src.split(TOKEN)) {
    if (!part) continue;
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`'))
      out.push({ kind: 'code', text: part.slice(1, -1) });
    else if (part.length > 4 && part.startsWith('**') && part.endsWith('**'))
      out.push({ kind: 'strong', text: part.slice(2, -2) });
    else out.push({ kind: 'text', text: part });
  }
  return out;
}

/** Plain text of a heading (markers removed), for names and the table of contents. */
const plain = (src: string) =>
  parseInline(src)
    .map((i) => i.text)
    .join('');

const HEADING = /^(#{1,6})\s+/;

/** Drop `<!-- ... -->` comments (an unclosed one runs to the end) without regex backtracking. */
function stripComments(md: string): string {
  let out = '';
  let pos = 0;
  for (;;) {
    const open = md.indexOf('<!--', pos);
    if (open < 0) return out + md.slice(pos);
    out += md.slice(pos, open);
    const close = md.indexOf('-->', open + 4);
    if (close < 0) return out;
    pos = close + 3;
  }
}

/** Heading text without surrounding blanks and a trailing run of `#` (closing marker). */
function headingText(rest: string): string {
  let t = rest.trim();
  if (t.endsWith('#')) {
    let end = t.length;
    while (end > 0 && t[end - 1] === '#') end--;
    t = t.slice(0, end).trimEnd();
  }
  return t;
}
const ITEM = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

export function parseGuide(md: string, idPrefix = 'guide-h'): Block[] {
  const lines = stripComments(md).split(/\r?\n/);
  const blocks: Block[] = [];
  let para: string[] = [];
  let headings = 0;
  // Open lists, outermost first; `indent` is the item marker's column.
  let stack: { indent: number; block: Extract<Block, { type: 'list' }> }[] = [];
  let lastItem: { text: string; item: ListItem } | null = null;

  const flushPara = () => {
    if (para.length) blocks.push({ type: 'p', inline: parseInline(para.join(' ')) });
    para = [];
  };
  const closeLists = () => {
    stack = [];
    lastItem = null;
  };
  const setItemText = () => {
    if (lastItem) lastItem.item.inline = parseInline(lastItem.text);
  };

  for (const line of lines) {
    const h = HEADING.exec(line);
    if (h) {
      flushPara();
      closeLists();
      const raw = headingText(line.slice(h[0].length));
      const text = plain(raw);
      blocks.push({
        type: 'heading',
        level: h[1]!.length,
        id: `${idPrefix}-${headings++}`,
        inline: parseInline(raw),
        text,
      });
      continue;
    }
    const m = ITEM.exec(line);
    if (m) {
      flushPara();
      const indent = m[1]!.replace(/\t/g, '    ').length;
      const ordered = /\d/.test(m[2]!);
      while (stack.length && stack[stack.length - 1]!.indent > indent) stack.pop();
      let top = stack[stack.length - 1];
      if (!top || (top.indent < indent && stack.length)) {
        const block: Extract<Block, { type: 'list' }> = { type: 'list', ordered, items: [] };
        if (top && lastItem) lastItem.item.children.push(block);
        else blocks.push(block);
        top = { indent, block };
        stack.push(top);
      } else if (top.block.ordered !== ordered) {
        stack.pop();
        const block: Extract<Block, { type: 'list' }> = { type: 'list', ordered, items: [] };
        const parent = stack[stack.length - 1];
        if (parent && lastItem) lastItem.item.children.push(block);
        else blocks.push(block);
        top = { indent, block };
        stack.push(top);
      }
      const item: ListItem = { inline: parseInline(m[3]!), children: [] };
      top.block.items.push(item);
      lastItem = { text: m[3]!, item };
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      continue;
    }
    if (lastItem && /^\s+\S/.test(line)) {
      // A wrapped line of the current list item.
      lastItem.text += ` ${line.trim()}`;
      setItemText();
      continue;
    }
    closeLists();
    para.push(line.trim());
  }
  flushPara();
  return blocks;
}

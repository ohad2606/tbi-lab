import { describe, expect, it } from 'vitest';
import { parseGuide, parseInline } from '../src/ui/guideMarkdown.js';
import guideEn from '../../docs/product/USER-GUIDE.en.md?raw';
import guideHe from '../../docs/product/USER-GUIDE.he.md?raw';

describe('guide markdown subset', () => {
  it('reads headings, paragraphs, bold and code spans; drops comments', () => {
    const b = parseGuide('# T\n\nHello **big** `Esc` <!-- note -->world\n\n## Two\n');
    expect(b.map((x) => x.type)).toEqual(['heading', 'p', 'heading']);
    expect(b[1]).toEqual({
      type: 'p',
      inline: [
        { kind: 'text', text: 'Hello ' },
        { kind: 'strong', text: 'big' },
        { kind: 'text', text: ' ' },
        { kind: 'code', text: 'Esc' },
        { kind: 'text', text: ' world' },
      ],
    });
    expect(b[2]).toMatchObject({ level: 2, text: 'Two', id: 'guide-h-1' });
  });

  it('nests lists and keeps ordered and unordered apart', () => {
    const b = parseGuide('1. one\n2. two\n   - a\n   - b\n3. three\n');
    expect(b).toHaveLength(1);
    const list = b[0]! as Extract<(typeof b)[number], { type: 'list' }>;
    expect(list.ordered).toBe(true);
    expect(list.items).toHaveLength(3);
    const inner = list.items[1]!.children[0]! as typeof list;
    expect(inner.ordered).toBe(false);
    expect(inner.items).toHaveLength(2);
  });

  it('keeps HTML and links as literal text (no markup is produced)', () => {
    const src = '<img src=x onerror=alert(1)> <script>alert(1)</script> [a](javascript:alert(1))';
    const b = parseGuide(src);
    expect(b).toHaveLength(1);
    const inline = (b[0] as { inline: ReturnType<typeof parseInline> }).inline;
    expect(inline.every((i) => i.kind === 'text')).toBe(true);
    expect(inline.map((i) => i.text).join('')).toBe(src);
    // Inside a code span and a heading as well: still only text.
    const h = parseGuide('## <b>x</b> `<i>y</i>`')[0]!;
    expect(h).toMatchObject({ type: 'heading', text: '<b>x</b> <i>y</i>' });
  });

  it('parses both shipped guides: same section count, no leftover markers', () => {
    const en = parseGuide(guideEn);
    const he = parseGuide(guideHe);
    const sections = (bs: typeof en) => bs.filter((x) => x.type === 'heading' && x.level === 2);
    expect(sections(en).length).toBeGreaterThanOrEqual(8);
    expect(sections(he)).toHaveLength(sections(en).length);
    for (const b of [...en, ...he]) {
      const text = JSON.stringify(b);
      expect(text).not.toContain('<!--');
      expect(text).not.toContain('**');
    }
  });
});

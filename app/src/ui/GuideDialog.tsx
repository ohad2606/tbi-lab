/**
 * The Help panel (TBI-020 slice 4): the beginner user guide (docs/product/USER-GUIDE.*.md,
 * imported at build time) in a modal dialog. The text is read by a tiny markdown-subset parser
 * (guideMarkdown.ts) and rendered as Preact elements, never as HTML. A native modal `<dialog>`
 * labelled by its heading; the heading takes focus on open, Escape closes, focus returns to the
 * opener. A table of contents jumps to a section and focuses its heading. Code spans (key and pin
 * names) are LTR inside the RTL page.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import guideEn from '../../../docs/product/USER-GUIDE.en.md?raw';
import guideHe from '../../../docs/product/USER-GUIDE.he.md?raw';
import { parseGuide, type Block, type Inline } from './guideMarkdown.js';
import { useAppState, useT } from './context.js';
import { isolateKeyNames, openShortcuts } from './ShortcutsDialog.js';

const GUIDES: Record<string, string> = { en: guideEn, he: guideHe };

const listeners = new Set<(trigger: HTMLElement | null) => void>();
/** Open the Help panel; focus returns to `trigger` when it closes. */
export function openGuide(trigger: HTMLElement | null): void {
  for (const l of listeners) l(trigger);
}

/** Mounted once (App): the dialog while it is open. */
export function GuideHost() {
  const [trigger, setTrigger] = useState<{ el: HTMLElement | null } | null>(null);
  useEffect(() => {
    const open = (el: HTMLElement | null) => setTrigger((cur) => cur ?? { el });
    listeners.add(open);
    return () => void listeners.delete(open);
  }, []);
  return trigger ? <GuideDialog trigger={trigger.el} onClose={() => setTrigger(null)} /> : null;
}

function Inlines({ items }: { items: Inline[] }) {
  return (
    <>
      {items.map((i, n) =>
        i.kind === 'code' ? (
          <code key={n} dir="ltr" lang="en">
            {i.text}
          </code>
        ) : i.kind === 'strong' ? (
          <strong key={n}>{i.text}</strong>
        ) : (
          i.text
        ),
      )}
    </>
  );
}

function Blocks({ blocks }: { blocks: Block[] }): ComponentChildren {
  return (
    <>
      {blocks.map((b, n) => {
        if (b.type === 'p')
          return (
            <p key={n}>
              <Inlines items={b.inline} />
            </p>
          );
        if (b.type === 'list') {
          const Tag = b.ordered ? 'ol' : 'ul';
          return (
            <Tag key={n}>
              {b.items.map((it, k) => (
                <li key={k}>
                  <Inlines items={it.inline} />
                  <Blocks blocks={it.children} />
                </li>
              ))}
            </Tag>
          );
        }
        // The panel's own title is the h2: guide section (##) = h3, subsection (###) = h4.
        const level = Math.min(Math.max(b.level + 1, 3), 6);
        const H = `h${level}` as 'h3';
        return (
          <H key={n} id={b.id} tabIndex={-1}>
            <Inlines items={b.inline} />
          </H>
        );
      })}
    </>
  );
}

function GuideDialog({ trigger, onClose }: { trigger: HTMLElement | null; onClose: () => void }) {
  const t = useT();
  const { locale } = useAppState();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const blocks = useMemo(() => parseGuide(GUIDES[locale.code] ?? guideEn), [locale.code]);
  // The guide's own title (#) is the panel title; its sections (##) are the contents.
  const body = blocks.filter((b) => !(b.type === 'heading' && b.level === 1));
  const sections = blocks.filter((b) => b.type === 'heading' && b.level === 2);
  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    heading.current?.focus();
    return () => {
      d?.close();
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);
  const jump = (id: string) => (e: MouseEvent) => {
    e.preventDefault();
    const h = dialog.current?.querySelector<HTMLElement>(`#${id}`);
    h?.scrollIntoView({ block: 'start' });
    h?.focus({ preventScroll: true });
  };
  return (
    <dialog
      ref={dialog}
      class="dialog guide-dialog"
      dir={locale.dir}
      lang={locale.code}
      data-testid="guide-dialog"
      aria-modal="true"
      aria-labelledby="guide-title"
      aria-describedby="guide-intro"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 id="guide-title" ref={heading} tabIndex={-1}>
        {t('guide.title')}
      </h2>
      <p id="guide-intro">{isolateKeyNames(t('guide.intro'))}</p>
      <div class="guide-tools">
        <button
          type="button"
          class="button"
          data-testid="guide-shortcuts"
          aria-haspopup="dialog"
          onClick={(e) => openShortcuts(e.currentTarget)}
        >
          {t('guide.shortcuts')}
        </button>
      </div>
      <nav aria-label={t('guide.contents')} data-testid="guide-toc">
        <ul class="guide-toc">
          {sections.map(
            (s) =>
              s.type === 'heading' && (
                <li key={s.id}>
                  <a href={`#${s.id}`} onClick={jump(s.id)}>
                    {s.text}
                  </a>
                </li>
              ),
          )}
        </ul>
      </nav>
      <div
        class="guide-body"
        role="region"
        tabIndex={0}
        aria-label={t('guide.textRegion')}
        data-testid="guide-body"
      >
        <Blocks blocks={body} />
      </div>
      <div class="dialog-actions">
        <button type="button" class="button" data-testid="guide-close" onClick={onClose}>
          {t('guide.close')}
        </button>
      </div>
    </dialog>
  );
}

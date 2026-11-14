/**
 * A11Y-003 (accessibility assessment): entering and leaving the code editor is understandable and
 * operable by keyboard, in Arduino and MicroPython, English and Hebrew:
 * - the instruction is visible under the editor and is the editor's accessible description
 *   (aria-describedby; checked in the accessibility tree);
 * - Tab indents (two spaces) while editing; the code is otherwise preserved;
 * - Esc then Tab leaves the editor forward; Shift+Tab leaves backward;
 * - Ctrl+M (and the "Tab moves focus" button, aria-pressed) switches Tab to moving focus: Tab then
 *   leaves at once and the code is unchanged; Ctrl+M switches back; the choice survives a reload.
 */
import { expect, test, type Page } from '@playwright/test';
import { goToProjects, reopenFromLibrary, waitSaved } from './helpers.js';

const HINT = {
  en: { indent: 'press Esc, then Tab', moves: 'Tab moves focus out of the code editor' },
  he: { indent: 'הקישו Esc ואחר כך Tab', moves: 'Tab מעביר את המיקוד אל מחוץ לעורך הקוד' },
} as const;

async function openCode(page: Page, id: string, lang: 'en' | 'he') {
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('tbi-lab.editor.tabMovesFocus'));
  const library = page.getByTestId('example-list');
  await expect(library.or(page.getByTestId('canvas'))).toBeVisible();
  if (!(await library.isVisible())) await goToProjects(page);
  await page.getByTestId('language-select').selectOption(lang);
  await page.getByTestId(`open-example-${id}`).click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await waitSaved(page);
  await page.getByTestId('view-code').click();
}

/** The accessible description Chromium computes for the editor (its accessibility tree, CDP). */
async function description(page: Page): Promise<string> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '[data-testid="code-text"]',
    });
    const { nodes } = await cdp.send('Accessibility.getPartialAXTree', {
      nodeId,
      fetchRelatives: false,
    });
    const node = nodes[0] as { description?: { value?: string }; role?: { value?: string } };
    expect(node.role?.value).toBe('textbox');
    return String(node.description?.value ?? '');
  } finally {
    await cdp.detach();
  }
}

for (const lang of ['en', 'he'] as const)
  for (const [id, language] of [
    ['esp32-blink', 'Arduino'],
    ['mpy-blink', 'MicroPython'],
  ] as const)
    test(`A11Y-003 (${lang}, ${language}): instruction exposed; Tab indents; Esc+Tab and Shift+Tab leave; Ctrl+M toggles`, async ({
      page,
    }) => {
      await openCode(page, id, lang);
      const editor = page.getByTestId('code-text');
      const hint = page.getByTestId('code-editor-hint');
      // The instruction: visible, and the editor's description in the accessibility tree.
      await expect(hint).toBeVisible();
      await expect(hint).toContainText(HINT[lang].indent);
      await expect(editor).toHaveAttribute('aria-describedby', 'code-editor-hint');
      expect(await description(page)).toContain(HINT[lang].indent);
      const snap = await page.getByTestId('code-view').ariaSnapshot();
      expect(snap).toContain('textbox');
      // Entering: Tab from the control before the editor reaches it.
      await editor.focus();
      await expect(editor).toBeFocused();
      const original = await editor.inputValue();
      // Tab indents at the caret (start of the text), nothing else changes.
      await editor.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 0));
      await page.keyboard.press('Tab');
      await expect(editor).toBeFocused();
      await expect(editor).toHaveValue(`  ${original}`);
      // Undo the indent with the editor's own Backspace twice: the code is back exactly.
      await page.keyboard.press('Backspace');
      await page.keyboard.press('Backspace');
      await expect(editor).toHaveValue(original);
      // Esc then Tab leaves forward.
      await page.keyboard.press('Escape');
      await page.keyboard.press('Tab');
      await expect(editor).not.toBeFocused();
      // Shift+Tab leaves backward.
      await editor.focus();
      await page.keyboard.press('Shift+Tab');
      await expect(editor).not.toBeFocused();
      // Ctrl+M: Tab moves focus; the hint says so and the button is pressed.
      await editor.focus();
      await page.keyboard.press('Control+m');
      await expect(hint).toHaveAttribute('data-tab-moves', 'true');
      await expect(hint).toContainText(HINT[lang].moves);
      await expect(page.getByTestId('code-tab-mode')).toHaveAttribute('aria-pressed', 'true');
      expect(await description(page)).toContain(HINT[lang].moves);
      await page.keyboard.press('Tab');
      await expect(editor).not.toBeFocused();
      await expect(editor).toHaveValue(original);
      // The choice survives a reload (per browser): reopen the project and look again.
      await page.reload();
      await reopenFromLibrary(page);
      await page.getByTestId('view-code').click();
      await expect(page.getByTestId('code-editor-hint')).toHaveAttribute('data-tab-moves', 'true');
      // Ctrl+M switches back: Tab indents again.
      await page.getByTestId('code-text').focus();
      await page.keyboard.press('Control+m');
      await expect(page.getByTestId('code-editor-hint')).toHaveAttribute('data-tab-moves', 'false');
      // The button toggles too.
      await page.getByTestId('code-tab-mode').click();
      await expect(page.getByTestId('code-tab-mode')).toHaveAttribute('aria-pressed', 'true');
      await page.getByTestId('code-tab-mode').click();
      await expect(page.getByTestId('code-tab-mode')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.getByTestId('code-text')).toHaveValue(original);
    });

/**
 * A translated sentence whose parameters are technical values (quantities, identifiers). Each
 * parameter is rendered as an LTR isolate element (`<bdi dir="ltr">`, CSS `unicode-bidi:
 * isolate`), so `1 nF` inside a Hebrew sentence never reorders to `nF 1` (owner report,
 * 2026-10-30), independently of the browser's support for the isolate control characters.
 */
import type { MessageKey } from '../i18n/i18n.js';
import { messageParts } from '../i18n/i18n.js';
import { useAppState } from './context.js';

export function LtrMessage({ k, params }: { k: MessageKey; params?: Record<string, string> }) {
  const { locale } = useAppState();
  return (
    <>
      {messageParts(locale, k).map((part, i) =>
        'text' in part ? (
          part.text
        ) : (
          <bdi key={i} dir="ltr" class="ltr-value">
            {params?.[part.param] ?? `{${part.param}}`}
          </bdi>
        ),
      )}
    </>
  );
}

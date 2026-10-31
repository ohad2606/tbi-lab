/**
 * Sprint 26: the program's managed libraries. Each pinned library shows its exact version, licence
 * and source, why it is there (a placed part needs it, or the code names it), the operations that
 * were validated on the simulator, its limitations and a usage example (copied only on request:
 * user code is never edited). Libraries the build service cannot provide are named as errors.
 */
import {
  libraryIssues,
  librariesNamedBy,
  managedLibrary,
  type ProgramLanguage,
  type ProgramSource,
  type ProjectDocument,
} from '@tbi-lab/domain';
import { useT } from './context.js';
import type { MessageKey } from '../i18n/messages.en.js';
import { isolateLtr } from '../i18n/i18n.js';

export function LibrariesPanel({ doc, program }: { doc: ProjectDocument; program: ProgramSource }) {
  const t = useT();
  const refs = program.libraries ?? [];
  const issues = libraryIssues(program);
  const language = program.language as ProgramLanguage;
  const named = new Set(
    [program.text, ...(program.files ?? []).map((f) => f.text)].flatMap((x) =>
      librariesNamedBy(language, x),
    ),
  );
  const types = new Set(doc.components.map((c) => c.type));
  return (
    <details class="code-libraries" data-testid="code-libraries" open={refs.length > 0}>
      <summary>
        {t('library.heading')}{' '}
        <span class="muted small" data-testid="code-libraries-count">
          {isolateLtr(String(refs.length))}
        </span>
      </summary>
      {refs.length === 0 && <p class="small muted">{t('library.none')}</p>}
      {issues.map((i) => (
        <p
          key={`${i.code}:${i.id}`}
          class="small field-error"
          role="alert"
          data-testid="library-issue"
          data-code={i.code}
        >
          {t(`library.issue.${i.code}` as MessageKey, { id: isolateLtr(i.id) })}
        </p>
      ))}
      <ul class="library-list">
        {refs.map((r) => {
          const lib = managedLibrary(r.id, r.version);
          if (!lib) return null;
          const parts = doc.components
            .filter((c) => lib.components.includes(c.type))
            .map((c) => c.id);
          const reasons = [
            ...(parts.length
              ? [t('library.reason.part', { parts: isolateLtr(parts.join(', ')) })]
              : []),
            ...(named.has(lib.id) ? [t('library.reason.code')] : []),
          ];
          return (
            <li key={lib.id} class="library" data-testid={`library-${lib.id}`}>
              <p>
                <strong class="technical" dir="ltr">
                  {lib.name}
                </strong>{' '}
                <span class="technical small" dir="ltr" data-testid="library-version">
                  {lib.version}
                </span>{' '}
                <span class="small muted" data-testid="library-status">
                  {t('library.status.available')}
                </span>
              </p>
              <p class="small">{reasons.join(' ')}</p>
              <p class="small">
                {t('library.license', {
                  spdx: isolateLtr(lib.license.spdx),
                  copyright: isolateLtr(lib.license.copyright),
                })}{' '}
                <span class="technical" dir="ltr">
                  {lib.source.url}
                  {lib.source.tag ? `@${lib.source.tag}` : ''} ({lib.source.commit.slice(0, 7)})
                </span>
              </p>
              <p class="small">
                {t('library.validated')}{' '}
                <span class="technical" dir="ltr" data-testid="library-validated">
                  {lib.validated.join(', ')}
                </span>
              </p>
              <ul class="small">
                {lib.limitations.map((k) => (
                  <li key={k}>{t(k as MessageKey)}</li>
                ))}
              </ul>
              {types.size > 0 && (
                <details class="library-example">
                  <summary class="small">{t('library.example')}</summary>
                  <pre class="technical" dir="ltr" data-testid="library-example">
                    {lib.example}
                  </pre>
                  <button
                    type="button"
                    class="button small"
                    data-testid="library-example-copy"
                    onClick={() => void navigator.clipboard?.writeText(lib.example)}
                  >
                    {t('library.copy')}
                  </button>
                </details>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

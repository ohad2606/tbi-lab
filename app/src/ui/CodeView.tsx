/**
 * The board's program (Sprint 7): a lightweight source editor (D-S7-3: a native textarea with a
 * line-number gutter and line/column, no editor dependency), the explicit Build action and its
 * state, the compiler's diagnostics mapped to lines, and bounded build details.
 *
 * Source text is user-authored and stored exactly; code is always left-to-right whatever the UI
 * locale. Build output never goes to the ESP32 terminal (that shows runtime serial output only).
 * Editing is allowed while a session runs (the session keeps its firmware); Build is not
 * (D-S7-9). Nothing builds automatically (D-S7-4).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  BUILD_PROFILES,
  PROGRAM_LIMITS,
  profileById,
  setProgramProfile,
  starterSourceFor,
  utf8Length,
  type ProgramSource,
} from '@tbi-lab/domain';
import { formatBytes } from './bytes.js';
import { useAppState, useStore, useT } from './context.js';
import { featureName } from '../sim/format.js';
import type { BuildView } from '../programs/state.js';
import { BuildElapsed } from './buildElapsed.js';
import type { Diagnostic } from '../programs/client.js';
import type { MessageKey } from '../i18n/messages.en.js';
import { isolateLtr } from '../i18n/i18n.js';
import { ProgramFiles } from './ProgramFiles.js';
import { LibrariesPanel } from './LibrariesPanel.js';

const NO_DIAGNOSTICS: Diagnostic[] = [];

/** Subscribe to the program build state (ephemeral, outside the project store). */
function useBuildView(
  projectId: string,
  boardId: string,
  program: ProgramSource,
): BuildView | null {
  const store = useStore();
  const builds = store.builds;
  const [, force] = useState(0);
  useEffect(() => builds?.subscribe(() => force((n) => n + 1)), [builds]);
  return builds ? builds.view(projectId, boardId, program) : null;
}

/** Offset of (line, column), both 1-based, in `text`. */
function offsetOf(text: string, line: number, column: number): number {
  let offset = 0;
  for (let l = 1; l < line; l++) {
    const next = text.indexOf('\n', offset);
    if (next < 0) return text.length;
    offset = next + 1;
  }
  const end = text.indexOf('\n', offset);
  return Math.min(offset + Math.max(0, column - 1), end < 0 ? text.length : end);
}

/**
 * A textarea's value always uses LF line breaks. The stored source keeps its own convention:
 * a file whose line breaks are all CRLF stays CRLF after an edit (text that is never edited is
 * never touched at all). Mixed line endings take LF once edited (documented limitation).
 */
function withLineEndings(original: string, edited: string): string {
  const crlf = original.includes('\r\n') && !/(^|[^\r])\n/.test(original);
  return crlf ? edited.replace(/\r?\n/g, '\r\n') : edited;
}

function positionOf(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  return { line, column: offset - before.lastIndexOf('\n') };
}

export function CodeView({ boardId, focusBuild }: { boardId: string; focusBuild: number }) {
  const { doc, sim, locale, readOnly } = useAppState();
  const store = useStore();
  const t = useT();
  const program = doc!.programs[boardId]!;
  const profile = profileById(program.profile);
  const view = useBuildView(doc!.projectId, boardId, program);
  const area = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const buildButton = useRef<HTMLButtonElement>(null);
  const escaped = useRef(false);
  const [pos, setPos] = useState({ line: 1, column: 1 });
  const active = sim.status === 'starting' || sim.status === 'running' || sim.status === 'stopping';
  // Sprint 26: the file open in the editor (UI state, not project data); the entry file when the
  // chosen one no longer exists (deleted, renamed, undone).
  const [chosen, setChosen] = useState(program.fileName);
  const files = program.files ?? [];
  const file =
    chosen !== program.fileName && files.some((f) => f.path === chosen) ? chosen : program.fileName;
  const text = file === program.fileName ? program.text : files.find((f) => f.path === file)!.text;
  const pendingJump = useRef<Diagnostic | null>(null);

  useEffect(() => {
    if (focusBuild > 0) buildButton.current?.focus();
  }, [focusBuild]);

  const lines = useMemo(() => text.split('\n').length, [text]);
  const result = view?.result ?? (view?.phase === 'required' ? view.previous : undefined);
  // Diagnostics are shown for the current source only (a stale build's lines may have moved).
  const diagnostics = view?.result?.diagnostics ?? NO_DIAGNOSTICS;
  const marked = useMemo(() => {
    const m = new Map<number, Diagnostic['severity']>();
    for (const d of diagnostics)
      if (
        d.line &&
        (d.file ?? program.fileName) === file &&
        (m.get(d.line) !== 'error' || d.severity === 'error')
      )
        m.set(d.line, d.severity);
    return m;
  }, [diagnostics, file, program.fileName]);

  // Re-rendered only when the number of lines or the diagnostics change, not per keystroke.
  const gutterLines = useMemo(
    () =>
      Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          class={marked.has(i + 1) ? `gutter-line mark-${marked.get(i + 1)}` : 'gutter-line'}
        >
          {i + 1}
        </div>
      )),
    [lines, marked],
  );

  // Scroll events keep the gutter aligned; re-align only when the gutter itself changes. (Reading
  // the textarea's scroll position on every render forces a layout of the whole text: measured
  // as most of the per-keystroke cost of a large sketch.)
  useLayoutEffect(() => {
    if (gutter.current && area.current) gutter.current.scrollTop = area.current.scrollTop;
  }, [gutterLines]);

  const track = () => {
    const el = area.current;
    if (el) setPos(positionOf(el.value, el.selectionStart));
  };

  const jump = (d: Diagnostic) => {
    // Sprint 26: a diagnostic in another file opens that file first, then jumps.
    if ((d.file ?? program.fileName) !== file) {
      pendingJump.current = d;
      setChosen(d.file ?? program.fileName);
      return;
    }
    const el = area.current;
    if (!el || !d.line) return;
    const at = offsetOf(el.value, d.line, d.column ?? 1);
    el.focus();
    el.setSelectionRange(at, at);
    // Bring the line into view (line height from the computed style).
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 18;
    el.scrollTop = Math.max(0, (d.line - 3) * lh);
    track();
  };

  const phaseKey: Record<BuildView['phase'], MessageKey> = {
    required: 'build.phase.required',
    building: 'build.phase.building',
    current: 'build.phase.current',
    failed: 'build.phase.failed',
  };
  const phase = view?.phase ?? 'required';
  const f = view?.phase === 'current' ? view.result?.features : undefined;
  const unsupported = f
    ? [
        ...(f.internalPull.length ? ['internal_pull'] : []),
        ...(f.gpioInterrupt.length ? ['interrupt'] : []),
        ...(f.restart ? ['restart'] : []),
        ...f.unsupported,
      ]
    : [];
  const size = utf8Length(text);
  const total = utf8Length(program.text) + files.reduce((n, f) => n + utf8Length(f.text), 0);
  useEffect(() => {
    const d = pendingJump.current;
    pendingJump.current = null;
    if (d) jump(d);
  }, [file]);

  return (
    <section class="code-view" data-testid="code-view" aria-label={t('program.tab.code')}>
      <header class="code-bar">
        {/* Sprint 19B: the programming environment (Arduino C++ or the genuine MicroPython
            interpreter). Switching starts that environment's starter program: code is never
            translated between languages; edited code is replaced only after confirmation. */}
        <label class="code-language">
          <span class="visually-hidden">{t('program.language')}</span>
          <select
            data-testid="program-language"
            value={program.profile}
            disabled={!!readOnly || active}
            onChange={(e) => {
              const next = (e.target as HTMLSelectElement).value;
              const edited =
                files.length > 0 ||
                program.text !==
                  starterSourceFor(profileById(program.profile)?.language ?? 'arduino-cpp');
              if (edited && !window.confirm(t('program.language.confirm'))) {
                (e.target as HTMLSelectElement).value = program.profile;
                return;
              }
              if (doc) store.apply(setProgramProfile(doc, boardId, next));
            }}
          >
            {BUILD_PROFILES.filter(
              (p) => p.board === doc!.components.find((c) => c.id === boardId)?.type,
            ).map((p) => (
              <option key={p.id} value={p.id}>
                {t(`program.language.${p.language}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <span class="code-file technical" dir="ltr" data-testid="code-file-active">
          {file}
        </span>
        <span
          class={`build-phase phase-${phase}`}
          role="status"
          aria-live="polite"
          data-testid="build-phase"
          data-phase={phase}
        >
          <span class="build-dot" aria-hidden="true" />
          {view?.phase === 'building' && view.position !== undefined
            ? t('build.phase.queued', { position: String(view.position + 1) })
            : t(phaseKey[phase])}
        </span>
        <BuildElapsed since={view?.phase === 'building' ? view.since : undefined} />
        <button
          ref={buildButton}
          type="button"
          class="button build-button"
          data-testid="build-button"
          disabled={
            !store.builds?.available ||
            !!readOnly ||
            active ||
            phase === 'building' ||
            !!view?.olderBuildRunning
          }
          aria-describedby={
            !store.builds?.available
              ? 'build-unavailable-note'
              : active
                ? 'build-blocked-note'
                : view?.olderBuildRunning
                  ? 'build-older-note'
                  : undefined
          }
          onClick={() => void store.buildProgram(boardId)}
        >
          {t('build.button')}
        </button>
        {profile && (
          <span class="code-toolchain muted small technical" dir="ltr">
            {profile.toolchain}
          </span>
        )}
      </header>
      <div class="code-notes">
        {!store.builds?.available && (
          <p class="small" id="build-unavailable-note">
            {t('build.unavailable')}
          </p>
        )}
        {active && (
          <p class="small" id="build-blocked-note" data-testid="build-blocked-note">
            {t('build.blockedRunning')}
          </p>
        )}
        {view?.olderBuildRunning && (
          <p class="small" id="build-older-note" role="status" data-testid="build-older-running">
            {t('build.olderRunning')}
          </p>
        )}
        {view?.phase === 'required' && view.previous && (
          <p class="small muted" data-testid="build-stale">
            {t('build.stale')}
          </p>
        )}
        {view?.error && (
          <p class="small field-error" role="alert" data-testid="build-error">
            {t(`build.error.${view.error}` as MessageKey)}
          </p>
        )}
        {view?.phase === 'failed' &&
          view.result?.failure &&
          view.result.failure !== 'compile_error' && (
            <p class="small field-error" role="alert" data-testid="build-failure">
              {t(`build.failure.${view.result.failure}` as MessageKey)}
            </p>
          )}
        {unsupported.length > 0 && (
          <div class="build-features" role="status" data-testid="build-features">
            <p class="small">{t('build.features.note')}</p>
            <ul class="small">
              {unsupported.map((x) => (
                <li key={x} data-feature={x}>
                  {featureName(locale, x)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <ProgramFiles
        boardId={boardId}
        program={program}
        active={file}
        onSelect={setChosen}
        disabled={false}
      />
      <div class="code-editor" dir="ltr">
        <div class="code-gutter" ref={gutter} aria-hidden="true">
          {gutterLines}
        </div>
        <textarea
          ref={area}
          class="code-text"
          data-testid="code-text"
          dir="ltr"
          wrap="off"
          spellcheck={false}
          autocapitalize="off"
          autocomplete="off"
          aria-label={t('program.editor.label', { board: boardId })}
          data-file={file}
          readOnly={!!readOnly}
          value={text.replace(/\r\n/g, '\n')}
          onInput={(e) => {
            store.setProgramText(boardId, withLineEndings(text, e.currentTarget.value), file);
            track();
          }}
          onScroll={(e) => {
            if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
          }}
          onKeyUp={track}
          onClick={track}
          onKeyDown={(e) => {
            // Tab indents (two spaces). Escape, then Tab, leaves the editor (no keyboard trap).
            if (e.key === 'Escape') {
              escaped.current = true;
              return;
            }
            if (e.key === 'Tab' && !escaped.current && !e.shiftKey && !readOnly) {
              e.preventDefault();
              const el = e.currentTarget;
              el.setRangeText('  ', el.selectionStart, el.selectionEnd, 'end');
              store.setProgramText(boardId, withLineEndings(text, el.value), file);
              track();
            }
            escaped.current = false;
          }}
        />
      </div>
      <footer class="code-status small muted">
        <span dir="ltr" data-testid="code-position">
          {t('program.position', { line: String(pos.line), column: String(pos.column) })}
        </span>
        {profile && (
          <span data-testid="code-size">
            {t('program.size', {
              used: isolateLtr(formatBytes(locale, size)),
              max: isolateLtr(formatBytes(locale, profile.maxSourceBytes)),
            })}
          </span>
        )}
        {files.length > 0 && (
          <span data-testid="code-total">
            {t('program.total', {
              files: isolateLtr(String(files.length + 1)),
              used: isolateLtr(formatBytes(locale, total)),
              max: isolateLtr(formatBytes(locale, PROGRAM_LIMITS.maxTotalBytes)),
            })}
          </span>
        )}
      </footer>
      {diagnostics.length > 0 && (
        <section
          class="build-diagnostics"
          data-testid="build-diagnostics"
          aria-labelledby="diag-heading"
        >
          <h3 id="diag-heading">{t('build.diagnostics.heading')}</h3>
          <ul>
            {diagnostics.map((d, i) => (
              <li key={i} class={`diag diag-${d.severity}`}>
                <button
                  type="button"
                  class="diag-jump"
                  data-testid="diagnostic"
                  data-line={d.line}
                  data-file={d.file ?? program.fileName}
                  disabled={!d.line}
                  onClick={() => jump(d)}
                >
                  <span class="diag-severity">
                    {t(`build.severity.${d.severity}` as MessageKey)}
                  </span>
                  {d.line && (
                    <span class="diag-where technical" dir="ltr">
                      {`${d.file ?? program.fileName}:${d.line}${d.column ? `:${d.column}` : ''}`}
                    </span>
                  )}
                  <span class="diag-message technical" dir="ltr">
                    {d.message}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <LibrariesPanel doc={doc!} program={program} />
      {result && (
        <details class="build-details" data-testid="build-details">
          <summary>{t('build.details')}</summary>
          {result.artifact && (
            <p class="small technical" dir="ltr" data-testid="build-artifact">
              {t('build.artifact', { id: result.artifact.sha256.slice(0, 16) })}
            </p>
          )}
          {result.sizes && (
            <p class="small">
              {t('build.sizes', {
                program: isolateLtr(String(result.sizes.program)),
                programMax: isolateLtr(String(result.sizes.programMax)),
                data: isolateLtr(String(result.sizes.data)),
                dataMax: isolateLtr(String(result.sizes.dataMax)),
              })}
            </p>
          )}
          {result.log.text && (
            <pre class="build-log" dir="ltr">
              {result.log.text}
            </pre>
          )}
        </details>
      )}
    </section>
  );
}

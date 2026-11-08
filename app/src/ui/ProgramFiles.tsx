/**
 * Sprint 26: the program's files as tabs. The entry file (`sketch.ino` / `main.py`) comes first,
 * is marked as the main file and can be neither renamed nor deleted; further files can be
 * created, renamed and deleted (each one undo step). Names follow the environment's rules
 * (domain `programPathIssue`), explained before anything is created. File names are technical
 * text: always left-to-right.
 */
import { useState } from 'preact/hooks';
import {
  profileById,
  programPathIssue,
  type ProgramPathIssue,
  type ProgramSource,
} from '@tbi-lab/domain';
import { useAppState, useStore, useT } from './context.js';
import type { MessageKey } from '../i18n/messages.en.js';
import { isolateLtr } from '../i18n/i18n.js';

export function ProgramFiles({
  boardId,
  program,
  active,
  onSelect,
  disabled,
}: {
  boardId: string;
  program: ProgramSource;
  active: string;
  onSelect: (path: string) => void;
  disabled: boolean;
}) {
  const store = useStore();
  const { readOnly } = useAppState();
  const t = useT();
  const profile = profileById(program.profile);
  const files = program.files ?? [];
  const [mode, setMode] = useState<null | 'new' | 'rename'>(null);
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<ProgramPathIssue | 'limit' | null>(null);
  const locked = !!readOnly || disabled;

  const issueOf = (path: string): ProgramPathIssue | null =>
    profile
      ? programPathIssue(
          profile.language,
          path,
          files.map((f) => f.path).filter((p) => mode !== 'rename' || p !== active),
          profile.fileName,
        )
      : 'bad_name';

  const submit = (e: Event) => {
    e.preventDefault();
    const path = name.trim();
    const why = issueOf(path);
    if (why) return setProblem(why);
    const r =
      mode === 'rename'
        ? store.renameProgramFile(boardId, active, path)
        : store.addProgramFile(boardId, path);
    if (!r.ok) return setProblem(r.error === 'file_exists' ? 'duplicate' : 'limit');
    setMode(null);
    setName('');
    setProblem(null);
    onSelect(path);
  };

  const tab = (path: string, main: boolean) => (
    <button
      key={path}
      type="button"
      role="tab"
      class={`code-file-tab${path === active ? ' active' : ''}`}
      aria-selected={path === active}
      data-testid={`code-file-${path}`}
      data-path={path}
      onClick={() => onSelect(path)}
    >
      <span class="technical" dir="ltr">
        {path}
      </span>
      {main && (
        <span class="code-file-main small" data-testid="code-file-main">
          {t('program.file.main')}
        </span>
      )}
    </button>
  );

  const isEntry = active === program.fileName;
  return (
    <div class="code-files" data-testid="code-files">
      <div class="code-file-tabs" role="tablist" aria-label={t('program.files')}>
        {tab(program.fileName, true)}
        {files.map((f) => tab(f.path, false))}
        <button
          type="button"
          class="button small code-file-new"
          data-testid="code-file-new"
          disabled={locked || files.length + 1 >= 16}
          onClick={() => {
            setMode('new');
            setName(profile?.language === 'micropython' ? 'module.py' : 'helpers.h');
            setProblem(null);
          }}
        >
          {t('program.file.new')}
        </button>
        {!isEntry && (
          <>
            <button
              type="button"
              class="button small"
              data-testid="code-file-rename"
              disabled={locked}
              onClick={() => {
                setMode('rename');
                setName(active);
                setProblem(null);
              }}
            >
              {t('program.file.rename')}
            </button>
            <button
              type="button"
              class="button small"
              data-testid="code-file-delete"
              disabled={locked}
              onClick={() => {
                if (!window.confirm(t('program.file.deleteConfirm', { file: isolateLtr(active) })))
                  return;
                if (store.deleteProgramFile(boardId, active)) onSelect(program.fileName);
              }}
            >
              {t('program.file.delete')}
            </button>
          </>
        )}
      </div>
      {mode && (
        <form class="code-file-form" data-testid="code-file-form" onSubmit={submit}>
          <label>
            <span class="small">
              {t(mode === 'new' ? 'program.file.newLabel' : 'program.file.renameLabel')}
            </span>
            <input
              type="text"
              dir="ltr"
              class="technical"
              data-testid="code-file-name"
              value={name}
              autoFocus
              spellcheck={false}
              autocapitalize="off"
              autocomplete="off"
              onInput={(e) => {
                setName(e.currentTarget.value);
                setProblem(null);
              }}
            />
          </label>
          <button type="submit" class="button small" data-testid="code-file-create">
            {t(mode === 'new' ? 'program.file.create' : 'program.file.renameApply')}
          </button>
          <button
            type="button"
            class="button small"
            onClick={() => {
              setMode(null);
              setProblem(null);
            }}
          >
            {t('program.file.cancel')}
          </button>
          <p class="small muted">
            {t(
              profile?.language === 'micropython'
                ? 'program.file.rules.micropython'
                : 'program.file.rules.arduino',
            )}
          </p>
          {problem && (
            <p class="small field-error" role="alert" data-testid="code-file-error">
              {t(`program.file.error.${problem}` as MessageKey)}
            </p>
          )}
        </form>
      )}
    </div>
  );
}

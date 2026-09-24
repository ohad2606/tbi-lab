import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { PACKAGE_EXTENSION, PACKAGE_MAX_BYTES, PACKAGE_MEDIA_TYPE } from '@tbi-lab/domain';
import { downloadProject } from './download.js';
import logoUrl from '../assets/brand/tbi-logo.png';
import { EXAMPLES } from '../examples/catalog.js';
import { formatDateTime, isolateUserText, type LocaleInfo } from '../i18n/i18n.js';
import type { ProjectIndexEntry } from '../persistence/store.js';
import { useAppState, useStore, useT } from './context.js';

/** The project library: new project, examples, import, and every local project. */
export function Home() {
  const state = useAppState();
  const store = useStore();
  const t = useT();
  const [name, setName] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ProjectIndexEntry | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // Suggest the first free default name, so accepting the suggestion never conflicts.
  const value = name ?? store.defaultProjectName(state.projects.map((p) => p.name));
  const createConflict = state.nameConflict?.scope === 'create' ? state.nameConflict : null;
  // Rows get the locale and translation as props and are rebuilt only when the list or the
  // language changes: 50+ rows each subscribed to the whole app state made every store update
  // re-render the entire library (Sprint 5 measurement).
  const rows = useMemo(
    () =>
      state.projects.map((p) => (
        <ProjectRow
          key={p.projectId}
          entry={p}
          locale={state.locale}
          t={t}
          onDelete={() => setDeleting(p)}
        />
      )),
    [state.projects, state.locale],
  );

  const importFile = async (file: File) => {
    if (file.size > PACKAGE_MAX_BYTES) {
      store.notify({ key: 'import.error.too_large' });
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      store.notify({ key: 'import.error.read' });
      return;
    }
    await store.importPackage(text);
  };

  return (
    <main class="home">
      <header class="brand-hero">
        <img
          class="brand-hero-logo"
          src={logoUrl}
          alt={t('brand.logoAlt')}
          width={533}
          height={300}
          decoding="async"
        />
        <div class="brand-hero-text">
          <h1>{t('home.title')}</h1>
          <p>{t('home.subtitle')}</p>
        </div>
        <div class="home-header-actions">
          <input
            ref={fileInput}
            type="file"
            class="visually-hidden"
            tabIndex={-1}
            accept={`${PACKAGE_EXTENSION},application/json,${PACKAGE_MEDIA_TYPE}`}
            aria-label={t('library.import.label')}
            data-testid="import-file"
            onChange={(e) => {
              const input = e.currentTarget;
              const file = input.files?.[0];
              input.value = ''; // the same file can be chosen again after a refusal
              if (file) void importFile(file);
            }}
          />
          <button
            type="button"
            class="button button-on-dark"
            data-testid="import-project"
            title={t('library.import.label')}
            onClick={() => fileInput.current?.click()}
          >
            {t('library.import.button')}
          </button>
        </div>
      </header>

      <div class="home-grid">
        <div class="home-column">
          <section class="card" aria-labelledby="new-project-heading">
            <h2 id="new-project-heading">{t('home.new.heading')}</h2>
            <form
              class="new-project"
              onSubmit={(e) => {
                e.preventDefault();
                // Read the submitted field itself, not state that may not have rendered yet.
                const field = e.currentTarget.elements.namedItem('projectName') as HTMLInputElement;
                void store.newProject(field.value);
              }}
            >
              <label>
                <span>{t('home.new.nameLabel')}</span>
                <input
                  data-testid="new-project-name"
                  name="projectName"
                  dir="auto"
                  value={value}
                  aria-invalid={createConflict ? 'true' : undefined}
                  aria-describedby={createConflict ? 'new-project-error' : undefined}
                  onInput={(e) => {
                    setName((e.target as HTMLInputElement).value);
                    store.clearNameConflict();
                  }}
                />
              </label>
              <button type="submit" class="button button-primary" data-testid="create-project">
                {t('home.new.create')}
              </button>
              {createConflict && (
                <p
                  class="field-error"
                  id="new-project-error"
                  role="alert"
                  data-testid="name-conflict"
                >
                  {t('library.error.nameTaken', { name: isolateUserText(createConflict.name) })}
                </p>
              )}
            </form>
          </section>

          <section class="card" aria-labelledby="recent-heading">
            <h2 id="recent-heading">{t('home.recent.heading')}</h2>
            {state.projects.length === 0 ? (
              <p class="muted">{t('home.recent.empty')}</p>
            ) : (
              <ul class="project-list" data-testid="project-list">
                {rows}
              </ul>
            )}
            <p class="muted small">{t('home.browserNote')}</p>
          </section>
        </div>
        <div class="home-column">
          <section class="card examples-card" aria-labelledby="examples-heading">
            <h2 id="examples-heading">{t('library.examples.heading')}</h2>
            <p class="muted small">{t('library.examples.intro')}</p>
            <ul class="example-list" data-testid="example-list">
              {EXAMPLES.map((ex) => (
                <li key={ex.id} class="example" data-testid={`example-${ex.id}`}>
                  <h3>{t(ex.titleKey)}</h3>
                  <p class="muted small">{t(ex.summaryKey)}</p>
                  <button
                    type="button"
                    class="button"
                    data-testid={`open-example-${ex.id}`}
                    aria-label={t('library.examples.openNamed', { name: t(ex.titleKey) })}
                    onClick={() => void store.openExample(ex.id)}
                  >
                    {t('library.examples.open')}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>

      {deleting && (
        <ConfirmDelete
          entry={deleting}
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            const id = deleting.projectId;
            setDeleting(null);
            void store.deleteProject(id);
          }}
        />
      )}
    </main>
  );
}

function ProjectRow({
  entry,
  locale,
  t,
  onDelete,
}: {
  entry: ProjectIndexEntry;
  locale: LocaleInfo;
  t: ReturnType<typeof useT>;
  onDelete: () => void;
}) {
  const store = useStore();
  const [renaming, setRenaming] = useState(false);
  const name = <bdi dir="auto">{entry.name}</bdi>;
  return (
    <li class="project-row" data-testid={`project-${entry.projectId}`} data-name={entry.name}>
      {renaming ? (
        <RenameForm entry={entry} t={t} onDone={() => setRenaming(false)} />
      ) : (
        <button
          type="button"
          class="project-entry"
          data-testid="open-project"
          aria-label={t('library.open', { name: entry.name })}
          onClick={() => void store.openProject(entry.projectId)}
        >
          <span class="project-entry-name">{name}</span>
          <span class="muted small">
            {t('home.recent.updated', { date: formatDateTime(locale, entry.updatedAt) })}
          </span>
        </button>
      )}
      {!renaming && (
        <div
          class="project-actions"
          role="group"
          aria-label={t('library.actions', { name: entry.name })}
        >
          <button
            type="button"
            class="button button-small"
            data-testid="rename-project"
            onClick={() => setRenaming(true)}
          >
            {t('library.rename')}
          </button>
          <button
            type="button"
            class="button button-small"
            data-testid="duplicate-project"
            onClick={() => void store.duplicate(entry.projectId)}
          >
            {t('library.duplicate')}
          </button>
          <button
            type="button"
            class="button button-small"
            data-testid="export-project"
            title={t('export.title')}
            onClick={() => void downloadProject(store, entry.projectId)}
          >
            {t('library.export')}
          </button>
          <button
            type="button"
            class="button button-small button-danger"
            data-testid="delete-project"
            onClick={onDelete}
          >
            {t('library.delete')}
          </button>
        </div>
      )}
    </li>
  );
}

function RenameForm({
  entry,
  t,
  onDone,
}: {
  entry: ProjectIndexEntry;
  t: ReturnType<typeof useT>;
  onDone: () => void;
}) {
  const store = useStore();
  const { nameConflict } = useAppState();
  const conflict =
    nameConflict?.scope === 'rename' && nameConflict.projectId === entry.projectId
      ? nameConflict
      : null;
  const errorId = `rename-error-${entry.projectId}`;
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const close = () => {
    store.clearNameConflict();
    onDone();
  };
  return (
    <form
      class="rename-form"
      onSubmit={(e) => {
        e.preventDefault();
        // Commit the field's own value (never a possibly unrendered draft).
        const field = e.currentTarget.elements.namedItem('newName') as HTMLInputElement;
        void store.renameInLibrary(entry.projectId, field.value).then((ok) => ok && onDone());
      }}
    >
      <input
        ref={input}
        name="newName"
        dir="auto"
        data-testid="rename-input"
        aria-label={t('library.rename.label', { name: entry.name })}
        defaultValue={entry.name}
        aria-invalid={conflict ? 'true' : undefined}
        aria-describedby={conflict ? errorId : undefined}
        onInput={() => store.clearNameConflict()}
        onKeyDown={(e) => e.key === 'Escape' && close()}
      />
      <button type="submit" class="button button-primary" data-testid="rename-save">
        {t('library.rename.save')}
      </button>
      <button type="button" class="button" onClick={close}>
        {t('library.rename.cancel')}
      </button>
      {conflict && (
        <p class="field-error" id={errorId} role="alert" data-testid="name-conflict">
          {t('library.error.nameTaken', { name: isolateUserText(conflict.name) })}
        </p>
      )}
    </form>
  );
}

/** A modal confirmation: keyboard focus starts on the safe choice; Esc keeps the project. */
function ConfirmDelete({
  entry,
  onClose,
  onConfirm,
}: {
  entry: ProjectIndexEntry;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      class="dialog"
      data-testid="delete-dialog"
      aria-labelledby="delete-title"
      aria-describedby="delete-body"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 id="delete-title">{t('library.delete.title')}</h2>
      <p id="delete-body">{t('library.delete.body', { name: isolateUserText(entry.name) })}</p>
      <div class="dialog-actions">
        <button
          type="button"
          class="button"
          data-testid="delete-cancel"
          autofocus
          onClick={onClose}
        >
          {t('library.delete.cancel')}
        </button>
        <button
          type="button"
          class="button button-danger-solid"
          data-testid="delete-confirm"
          onClick={onConfirm}
        >
          {t('library.delete.confirm')}
        </button>
      </div>
    </dialog>
  );
}

import { useEffect, useRef, useState } from 'preact/hooks';
import { PACKAGE_EXTENSION, PACKAGE_MAX_BYTES, PACKAGE_MEDIA_TYPE } from '@tbi-lab/domain';
import { downloadProject } from './download.js';
import { EXAMPLES } from '../examples/catalog.js';
import { formatDateTime } from '../i18n/i18n.js';
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
  const value = name ?? t('home.new.defaultName');

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
      <div class="home-header">
        <h1>{t('home.title')}</h1>
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
            class="button"
            data-testid="import-project"
            title={t('library.import.label')}
            onClick={() => fileInput.current?.click()}
          >
            {t('library.import.button')}
          </button>
        </div>
      </div>

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
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
            />
          </label>
          <button type="submit" class="button button-primary" data-testid="create-project">
            {t('home.new.create')}
          </button>
        </form>
      </section>

      <section class="card" aria-labelledby="examples-heading">
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

      <section class="card" aria-labelledby="recent-heading">
        <h2 id="recent-heading">{t('home.recent.heading')}</h2>
        {state.projects.length === 0 ? (
          <p class="muted">{t('home.recent.empty')}</p>
        ) : (
          <ul class="project-list" data-testid="project-list">
            {state.projects.map((p) => (
              <ProjectRow key={p.projectId} entry={p} onDelete={() => setDeleting(p)} />
            ))}
          </ul>
        )}
        <p class="muted small">{t('home.browserNote')}</p>
      </section>

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

function ProjectRow({ entry, onDelete }: { entry: ProjectIndexEntry; onDelete: () => void }) {
  const { locale } = useAppState();
  const store = useStore();
  const t = useT();
  const [renaming, setRenaming] = useState(false);
  const name = <bdi dir="auto">{entry.name}</bdi>;
  return (
    <li class="project-row" data-testid={`project-${entry.projectId}`} data-name={entry.name}>
      {renaming ? (
        <RenameForm entry={entry} onDone={() => setRenaming(false)} />
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

function RenameForm({ entry, onDone }: { entry: ProjectIndexEntry; onDone: () => void }) {
  const store = useStore();
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
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
        onKeyDown={(e) => e.key === 'Escape' && onDone()}
      />
      <button type="submit" class="button button-primary" data-testid="rename-save">
        {t('library.rename.save')}
      </button>
      <button type="button" class="button" onClick={onDone}>
        {t('library.rename.cancel')}
      </button>
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
      <p id="delete-body">{t('library.delete.body', { name: entry.name })}</p>
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

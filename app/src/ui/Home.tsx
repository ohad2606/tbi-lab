import { GettingStarted } from './GettingStarted.js';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { downloadProject } from './download.js';
import { useImportPicker } from './importFile.js';
import logoUrl from '../assets/brand/tbi-logo.png';
import {
  availableCategories,
  buildExampleIndex,
  matchExamples,
  type ExampleCategory,
} from '../examples/discover.js';
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
  const picker = useImportPicker();
  // Suggest the first free default name, so accepting the suggestion never conflicts.
  const value = name ?? store.defaultProjectName(state.projects.map((p) => p.name));
  const createConflict = state.nameConflict?.scope === 'create' ? state.nameConflict : null;
  // Sprint 13 H4: the first-run guide, until dismissed on this device.
  const [guide, setGuide] = useState(() => !store.onboardingDismissed());
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
      </header>

      {guide ? (
        <GettingStarted
          onDismiss={() => {
            store.setOnboardingDismissed(true);
            setGuide(false);
          }}
        />
      ) : (
        <p class="getting-started-reopen">
          <button
            type="button"
            class="link-button"
            data-testid="onboarding-show"
            onClick={() => {
              store.setOnboardingDismissed(false);
              setGuide(true);
            }}
          >
            {t('onboarding.show')}
          </button>
        </p>
      )}

      {/* Three areas: create something, reopen your work, start from an example. */}
      <div class="home-grid">
        <section class="card home-new" aria-labelledby="new-project-heading" data-testid="home-new">
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
          <div class="home-import">
            <span class="muted small">{t('home.import.lead')}</span>
            {picker.input}
            <button
              type="button"
              class="button"
              data-testid="import-project"
              title={t('library.import.label')}
              onClick={picker.choose}
            >
              {t('library.import.button')}
            </button>
          </div>
        </section>

        <section
          class="card home-recent"
          aria-labelledby="recent-heading"
          data-testid="home-recent"
        >
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

        <section
          class="card examples-card home-examples"
          aria-labelledby="examples-heading"
          data-testid="home-examples"
        >
          <h2 id="examples-heading">{t('library.examples.heading')}</h2>
          <p class="muted small">{t('library.examples.intro')}</p>
          <ExampleFinder onOpen={(id) => void store.openExample(id)} />
        </section>
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

/**
 * OS-12: the example library with search and category filters (examples/discover.ts). Filtering
 * is instant and local; opening an example is unchanged.
 */
function ExampleFinder({ onOpen }: { onOpen: (id: string) => void }) {
  const t = useT();
  const index = useMemo(() => buildExampleIndex(), []);
  const categories = useMemo(() => availableCategories(index), [index]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<ExampleCategory>>(new Set());
  const shown = matchExamples(index, query, selected);
  const active = query.trim() !== '' || selected.size > 0;
  const searchRef = useRef<HTMLInputElement>(null);
  const clear = () => {
    setQuery('');
    setSelected(new Set());
    searchRef.current?.focus();
  };
  const toggle = (id: ExampleCategory) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <>
      <div class="example-filters">
        <label class="example-search">
          <span>{t('library.examples.search')}</span>
          <input
            ref={searchRef}
            type="search"
            dir="auto"
            data-testid="example-search"
            value={query}
            placeholder={t('library.examples.searchHint')}
            aria-controls="example-list"
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query !== '') {
                e.preventDefault();
                setQuery('');
              }
            }}
          />
        </label>
        <div
          class="example-categories"
          role="group"
          aria-label={t('library.examples.categories')}
          data-testid="example-categories"
        >
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              class="button example-category"
              aria-pressed={selected.has(c.id) ? 'true' : 'false'}
              aria-controls="example-list"
              data-testid={`example-category-${c.id}`}
              onClick={() => toggle(c.id)}
            >
              {selected.has(c.id) && (
                // The selected state is not colour alone: a drawn check mark (the UI font has no
                // reliable \u2713 glyph).
                <svg class="example-category-check" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M2 6.5 5 9.5 10 3" />
                </svg>
              )}
              {t(c.labelKey)}
            </button>
          ))}
        </div>
        <div class="example-result-row">
          <p class="muted small" role="status" aria-live="polite" data-testid="example-count">
            {t('library.examples.count', { shown: shown.length, total: index.length })}
          </p>
          {active && (
            <button type="button" class="link-button" data-testid="example-clear" onClick={clear}>
              {t('library.examples.clear')}
            </button>
          )}
        </div>
      </div>
      {shown.length === 0 ? (
        <p class="example-empty" data-testid="example-empty">
          {t('library.examples.empty')}
        </p>
      ) : null}
      <ul class="example-list" id="example-list" data-testid="example-list">
        {shown.map((ex) => (
          <li key={ex.id} class="example" data-testid={`example-${ex.id}`}>
            <h3>{t(ex.titleKey)}</h3>
            <p class="muted small">{t(ex.summaryKey)}</p>
            <button
              type="button"
              class="button"
              data-testid={`open-example-${ex.id}`}
              aria-label={t('library.examples.openNamed', { name: t(ex.titleKey) })}
              onClick={() => onOpen(ex.id)}
            >
              {t('library.examples.open')}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

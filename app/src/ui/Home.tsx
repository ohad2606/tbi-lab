import { useState } from 'preact/hooks';
import { formatDateTime } from '../i18n/i18n.js';
import { useAppState, useStore, useT } from './context.js';

export function Home() {
  const state = useAppState();
  const store = useStore();
  const t = useT();
  const [name, setName] = useState<string | null>(null);
  const value = name ?? t('home.new.defaultName');
  return (
    <main class="home">
      <h1>{t('home.title')}</h1>
      <section class="card">
        <h2>{t('home.new.heading')}</h2>
        <form
          class="new-project"
          onSubmit={(e) => {
            e.preventDefault();
            void store.newProject(value);
          }}
        >
          <label>
            <span>{t('home.new.nameLabel')}</span>
            <input
              data-testid="new-project-name"
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
      <section class="card">
        <h2>{t('home.recent.heading')}</h2>
        {state.projects.length === 0 ? (
          <p class="muted">{t('home.recent.empty')}</p>
        ) : (
          <ul class="project-list" data-testid="project-list">
            {state.projects.map((p) => (
              <li key={p.projectId}>
                <button
                  type="button"
                  class="project-entry"
                  onClick={() => void store.openProject(p.projectId)}
                >
                  <bdi dir="auto" class="project-entry-name">
                    {p.name}
                  </bdi>
                  <span class="muted">
                    {t('home.recent.updated', { date: formatDateTime(state.locale, p.updatedAt) })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p class="muted small">{t('home.browserNote')}</p>
      </section>
    </main>
  );
}

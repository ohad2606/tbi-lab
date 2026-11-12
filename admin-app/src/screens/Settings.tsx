import { SIGN_OUT_URL } from '../common.js';
import { useConsole, useT } from '../context.js';
import { LOCALES } from '../i18n.js';

/** The language of this app (remembered in this browser) and signing out. */
export function Settings() {
  const t = useT();
  const { locale, setLocale } = useConsole();
  return (
    <section aria-labelledby="settings-h" class="stack">
      <h1 id="settings-h">{t('console.settings.heading')}</h1>
      <fieldset class="card stack">
        <legend>{t('console.settings.language')}</legend>
        {LOCALES.map((l) => (
          <label key={l.code} class="choice" lang={l.code} dir={l.dir}>
            <input
              type="radio"
              name="language"
              value={l.code}
              checked={locale.code === l.code}
              data-testid={`language-${l.code}`}
              onChange={() => setLocale(l.code)}
            />
            <span>{l.autonym}</span>
          </label>
        ))}
      </fieldset>
      <div class="card stack">
        <p class="muted">{t('admin.accounts.timeZone')}</p>
        <p class="muted">{t('console.settings.signOutHint')}</p>
        <a class="button" href={SIGN_OUT_URL} data-testid="sign-out-link">
          {t('console.settings.signOut')}
        </a>
      </div>
    </section>
  );
}

import { Icon, SIGN_OUT_URL, type IconName } from '../common.js';
import { useConsole, useT } from '../context.js';

/** The phone's "More" tab: the activity log, settings and signing out. */
export function More() {
  const t = useT();
  const { go, setNotice } = useConsole();
  const row = (name: 'activity' | 'settings', icon: IconName) => (
    <li class="item">
      <a
        class="item-link menu-link"
        href={`#/${name}`}
        data-testid={`more-${name}`}
        onClick={(e) => {
          e.preventDefault();
          setNotice(null);
          go({ name });
        }}
      >
        <Icon name={icon} />
        <span class="menu-label">{t(`console.nav.${name}`)}</span>
        <Icon name="forward" class="menu-chevron" />
      </a>
    </li>
  );
  return (
    <section aria-labelledby="more-h" class="stack">
      <h1 id="more-h">{t('console.nav.more')}</h1>
      <ul class="list" data-testid="more-menu">
        {row('activity', 'activity')}
        {row('settings', 'settings')}
        <li class="item">
          <a class="item-link menu-link" href={SIGN_OUT_URL} data-testid="more-sign-out">
            <Icon name="signOut" />
            <span class="menu-label">{t('console.settings.signOut')}</span>
          </a>
        </li>
      </ul>
    </section>
  );
}

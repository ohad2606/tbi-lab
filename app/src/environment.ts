/**
 * The deployment environment, fixed at build time by VITE_TBI_ENV (owner decision 2026-10-29).
 * Only DEV-Lab builds set it, to "dev" (deploy/release/dev-lab.release.json): the DEV icon set,
 * the DEV strip on every screen, "[DEV]" in the window title and a DEV label in the top bar.
 * Unset means the production branding (every other profile pins it unset).
 *
 * No browser or Vite globals here: the build configuration (vite.config.ts, which brands the HTML
 * and the web app manifest) and the app (deployment.ts) share this one parser, so the page and
 * the code can never disagree about the environment.
 */
export type TbiEnvironment = 'production' | 'dev';

/**
 * Unset or empty: production. "dev": DEV. Anything else is a configuration error. `setting` names
 * the source in the message; the build passes the variable's name, the app does not (the release
 * gate, check-dist.mjs, refuses a bundle that still names a VITE_ setting).
 */
export function parseTbiEnv(value: unknown, setting = 'the environment setting'): TbiEnvironment {
  if (value === undefined || value === null || value === '') return 'production';
  if (value === 'dev') return 'dev';
  throw new Error(`${setting} must be unset or "dev", not ${JSON.stringify(value)}`);
}

export const PRODUCT_NAME = 'TBI Lab';

/** The window title: "[DEV] " first on DEV, then a preview's name, then the product. */
export function documentTitle(env: TbiEnvironment, previewName: string | null = null): string {
  return `${env === 'dev' ? '[DEV] ' : ''}${previewName ? `${previewName} preview · ` : ''}${PRODUCT_NAME}`;
}

/** Brand colours of the installed app (web app manifest, browser UI). */
export const BRAND_COLOURS = {
  /** --brand-navy (styles.css): the app icon's dark ground. */
  navy: '#0a1a33',
  /** The DEV marker yellow (icons, strip): DEV-Lab's installed app and browser UI. */
  devYellow: '#ffcc00',
} as const;

/** The installed app's names (web app manifest; iOS home-screen title). */
export function appNames(env: TbiEnvironment): { name: string; shortName: string } {
  return env === 'dev'
    ? { name: `${PRODUCT_NAME} DEV`, shortName: `${PRODUCT_NAME} DEV` }
    : { name: PRODUCT_NAME, shortName: PRODUCT_NAME };
}

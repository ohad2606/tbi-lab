/**
 * The one Content-Security-Policy of the public site: sent by site/serve.mjs and, verbatim, by the
 * sign-up Caddy template (site/deploy/Caddyfile.signup.template; site/tests/signup-proxy.test.mjs
 * compares them). The built pages use no inline script or style.
 */
export const SITE_CSP =
  "default-src 'none'; img-src 'self'; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/**
 * The runtime's own build identity (Sprint 10): the product version and the exact commit this
 * Session Host bundle was built from, stamped by the bundler (deploy/dev-lab/publish-runtime.sh).
 * Read-only, reported on /health so the app's version details can name the runtime it talks to.
 * Nothing about the host machine: no paths, users or addresses. An unstamped build (tests, a
 * plain `npm run host:build`) reports nothing, exactly as before.
 */
declare const __TBI_RUNTIME_VERSION__: string | undefined;
declare const __TBI_RUNTIME_COMMIT__: string | undefined;

export interface RuntimeIdentity {
  version: string;
  commit: string;
}

export function runtimeIdentity(): RuntimeIdentity | null {
  const version = typeof __TBI_RUNTIME_VERSION__ === 'string' ? __TBI_RUNTIME_VERSION__ : '';
  const commit = typeof __TBI_RUNTIME_COMMIT__ === 'string' ? __TBI_RUNTIME_COMMIT__ : '';
  if (!/^[0-9a-z.+-]{1,32}$/i.test(version) || !/^[0-9a-f]{40}$/.test(commit)) return null;
  return { version, commit };
}

/**
 * Sprint 28: the AI provider service process (tbi-assist). INACTIVE unless fully approved.
 *
 *   TBI_ASSIST_LISTEN        `unix:/run/tbi-assist/api.sock` (deployment) or `127.0.0.1:port`
 *   TBI_SOCKET_GID           group of the socket (the gate's internal proxy)
 *   TBI_IDENTITY_KEY_FILE    the gate identity key (principals), as for every backend
 *   TBI_ASSIST_CONFIG        /etc/tbi/assist.json (absent or invalid: disabled)
 *   TBI_ASSIST_STATE         state directory (ledger, audit log)
 *   TBI_ASSIST_ALLOW_MOCK=1  accept provider.kind "mock" (tests, staging; never needed live)
 *   CREDENTIALS_DIRECTORY    systemd LoadCredential= directory; the provider key is the file
 *                            `provider-key` in it (never an environment variable)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { identityFromEnv } from '../identity/principal.js';
import { describeListen, listen, parseListen } from '../identity/listen.js';
import { activation, loadConfig } from './config.js';
import { Ledger } from './ledger.js';
import { createProvider } from './providers.js';
import { createAssistHttpServer } from './service.js';

const where = parseListen(process.env.TBI_ASSIST_LISTEN ?? '127.0.0.1:7440');
const socketGid = process.env.TBI_SOCKET_GID ? Number(process.env.TBI_SOCKET_GID) : undefined;
const identity = identityFromEnv();
const { config, error } = loadConfig(process.env.TBI_ASSIST_CONFIG);
const credFile = process.env.CREDENTIALS_DIRECTORY
  ? join(process.env.CREDENTIALS_DIRECTORY, 'provider-key')
  : null;
const env = {
  allowMock: process.env.TBI_ASSIST_ALLOW_MOCK === '1',
  credentialPresent: !!credFile && existsSync(credFile),
};
const act = error ? null : activation(config, env);
const provider =
  act?.state === 'active'
    ? createProvider(config, act.mode, () =>
        credFile ? readFileSync(credFile, 'utf8').trim() || null : null,
      )
    : null;
const ledger = new Ledger(process.env.TBI_ASSIST_STATE ?? '/var/lib/tbi-assist', config.retention);
setInterval(() => ledger.prune(), 3_600_000).unref();

const server = createAssistHttpServer({
  config,
  configError: error,
  identity,
  ledger,
  provider,
  env,
});
const stop = () => {
  server.close();
  server.closeAllConnections();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
await listen(server, where, socketGid);
// Start line: state and reasons only (never the configuration, principals or a credential).
process.stdout.write(
  `${JSON.stringify({
    event: 'start',
    listen: describeListen(where),
    state: provider ? 'active' : 'disabled',
    ...(provider ? { mode: provider.live ? 'live' : 'mock', model: provider.model } : {}),
    reasons: error ? [error.split(':')[0]] : act?.state === 'disabled' ? act.reasons : [],
  })}\n`,
);

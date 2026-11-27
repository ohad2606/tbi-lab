# Private stack for the browser-level gate cases

**Status: NOT REHEARSED.** Derived from code and configuration only (`playwright.app.config.ts`,
`app/vite.config.ts`, `runtime/host/main.ts`, `runtime/builder/main.ts`, `runtime/identity/`,
`scripts/owner-principal.mjs`). No command here has been run as a sequence; treat every step as
unverified until a rehearsal is recorded. The sources named are authoritative.

## Scope

The `*-real.spec.ts` specs need a real build service and Session Host behind the preview. This page
starts them as ordinary processes of one operator account, on loopback, from the commit under test.

It does **not** provide an installed instance. The deployed runtime tests and the unit kill / restart
cases of `s18-r4b-real` need the staging instance ([TEST-SAFETY.md](TEST-SAFETY.md), "Release
gate"). Processes started here have no systemd sandbox (without `TBI_BUILD_JOB_UNIT` the build tools
are child processes, "development only"), so serve test projects only.

Hold the pipeline lock for the whole time: these processes and the specs are heavy.

## Prerequisites

- A provisioned runtime: `runtime/provision/provision.sh check`, then `all`
  ([runtime/README.md](../../runtime/README.md)); set `TBI_RUNTIME_HOME` if not the default.
- `npm ci`, then `npm run host:build` and `npm run buildsvc:build`.
- Free ports: 7410, 7411, 7420 (examples used here) and the preview and fake ports of
  `playwright.app.config.ts` (4173 to 4176, 7496 to 7499).
- One `sudo` step for the owner reference file (below).

## Keys and private directories

In one shell, with a new private directory outside the repository:

```sh
umask 077
STACK=$(mktemp -d "$HOME/tbi-private-stack.XXXXXX")
head -c 32 /dev/urandom >"$STACK/identity.key"
head -c 32 /dev/urandom >"$STACK/ticket.key"
export TBI_IDENTITY_KEY_FILE="$STACK/identity.key" TBI_TICKET_KEY_FILE="$STACK/ticket.key"
export TBI_IDENTITY_ISSUER=test
```

Never use the keys of an installed instance. Leave unset in these shells: `TBI_HOST_RUNTIME_UNIT`,
`TBI_BUILD_JOB_UNIT`, `TBI_HOST_SESSION_ROOT`, `TBI_ACCESS_VIEW` and the other service variables not
named here (a set unit prefix makes the Session Host stop units of that name at start).

## Owner reference (reports mode)

`rc6-golden-real` reads its feedback back as the owner. The Session Host accepts the owner file only
if it is owned by root, in the host process's group, mode 0640 (`runtime/host/owner.ts`). The test
subject is `e2e-owner` unless `TBI_RC6_OWNER` says otherwise.

```sh
printf 'e2e-owner\n' |
  node scripts/owner-principal.mjs "$TBI_IDENTITY_KEY_FILE" --issuer test >"$STACK/owner.new"
sudo install -m 0640 -o root -g "$(id -gn)" "$STACK/owner.new" "$STACK/owner.principal"
```

## Services

Each in its own shell or in the background, with the exports above. Note each process ID and stop
only those. `RT` is the runtime home.

```sh
RT=${TBI_RUNTIME_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/tbi-lab-runtime}

# Build service, 127.0.0.1:7420
TBI_BUILD_LISTEN=127.0.0.1:7420 TBI_BUILD_STATE="$STACK/build-state" \
  TBI_BUILD_WORK="$STACK/build-jobs" TBI_RUNTIME_JSON="$RT/qemu-current/runtime.json" \
  node runtime/builder/dist/build-service.mjs

# Session Host, 127.0.0.1:7410
TBI_HOST_LISTEN=127.0.0.1:7410 TBI_HOST_STATE="$STACK/host-state" \
  node runtime/host/dist/session-host.mjs

# Second Session Host in reports mode, 127.0.0.1:7411 (the feedback preview)
TBI_HOST_LISTEN=127.0.0.1:7411 TBI_HOST_STATE="$STACK/feedback-state" \
  TBI_REPORTS_DIR="$STACK/reports" TBI_ADMIN_MODE=reports \
  TBI_OWNER_PRINCIPAL_FILE="$STACK/owner.principal" \
  node runtime/host/dist/session-host.mjs
```

Without `TBI_RUNTIME_JSON` the build service announces no capabilities and refuses what needs them.
Build service and both hosts share the artifact store (default `$RT/artifacts`).

## Specs

```sh
CI=1 TBI_RUNTIME_PROXY=http://127.0.0.1:7410 TBI_BUILD_PROXY=http://127.0.0.1:7420 \
  TBI_FEEDBACK_RUNTIME_PROXY=http://127.0.0.1:7411 TBI_S6_REAL=1 \
  npx playwright test -c playwright.app.config.ts e2e/s6-real.spec.ts --retries=0
```

Enable further specs with their `TBI_*_REAL` variable (list in TEST-SAFETY.md). The preview proxy
plays the sign-in gate (`TBI_TEST_GATE=1`); real sign-in is not exercised. A run like this is not a
release gate result.

## Stop and clean up

Send SIGTERM to the three process IDs noted above, check the ports are free, then remove `$STACK`
(the owner file inside it is root-owned; removing it from your own directory needs no `sudo`).

## Open until rehearsed

- Whether the built-in default policy (rate and quota limits) admits a full run of all real specs.
- Whether `TBI_ADMIN_PROXY` matters to any real spec (the preview default is port 7410).
- Memory and CPU need on a small host.

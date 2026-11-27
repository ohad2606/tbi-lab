# Private stack for the browser-level gate cases

**Status: NOT REHEARSED** as a whole. Derived from code and configuration
(`playwright.app.config.ts`, `app/vite.config.ts`, `runtime/host/main.ts`,
`runtime/builder/main.ts`, `runtime/identity/`, `scripts/owner-principal.mjs`). Tried once, on a
partly provisioned host: the lock commands, the directories, the three services answering health
(build prewarm off, without the owner file) and the stop commands. Not tried: the reference
firmware copy to completion, the `sudo` step, any spec. The sources named are authoritative.

**Single-user host only.** The services listen on loopback TCP ports that every local account and
process can reach. Do not use this on a host other people log in to, or one that serves users.

## Scope

The `*-real.spec.ts` specs need a real build service and Session Host behind the preview. This page
starts them as ordinary processes of one operator account, on loopback, from the commit under test.

It does **not** provide an installed instance. The deployed runtime tests and the unit kill / restart
cases of `s18-r4b-real` need the staging instance ([TEST-SAFETY.md](TEST-SAFETY.md), "Release
gate"). Processes started here have no systemd sandbox (without `TBI_BUILD_JOB_UNIT` the build tools
are child processes, "development only"), so serve test projects only.

Hold the pipeline lock for the whole time: these processes and the specs are heavy.

## Prerequisites

- An own provisioned runtime home: `runtime/provision/provision.sh check`, then `all`
  ([runtime/README.md](../../runtime/README.md)); set `TBI_RUNTIME_HOME` if not the default.
  **Never use the runtime home or the artifact store of an installed instance**: the services and
  tests write into them.
- `npm ci`, then `npm run host:build` and `npm run buildsvc:build`.
- Free ports: 17410, 17411, 17420 (examples used here) and the preview and fake ports of
  `playwright.app.config.ts` (4173 to 4176, 7496 to 7499).
- One `sudo` step for the owner reference file (below).

## Lock, keys and private directories

Run every block below in one shell, at the root of the commit under test.

```sh
export TBI_PIPELINE_OWNER=private-stack TBI_PIPELINE_PID=$$
node deploy/ops/pipeline-lock.mjs acquire --purpose "private stack"
```

Continue only if that printed success (exit 0); exit 75 means someone else holds the lock.

```sh
umask 077
export STACK=$(mktemp -d "$HOME/tbi-private-stack.XXXXXX")
export RT=${TBI_RUNTIME_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/tbi-lab-runtime}
export TBI_RUNTIME_HOME="$RT"
mkdir "$STACK/host-state" "$STACK/feedback-state" "$STACK/build-state" "$STACK/build-jobs" \
  "$STACK/artifacts"
head -c 32 /dev/urandom >"$STACK/identity.key"
head -c 32 /dev/urandom >"$STACK/ticket.key"
export TBI_IDENTITY_KEY_FILE="$STACK/identity.key" TBI_TICKET_KEY_FILE="$STACK/ticket.key"
export TBI_IDENTITY_ISSUER=test
```

The services do not create their state directories: without the `mkdir` they stop at start. The
build service and both hosts share the private artifact store `$STACK/artifacts`. The pinned
reference firmware (`runtime/firmware/artifacts.lock.json`) must be in it. A missing file
(`ENOENT` below) means the runtime home is not provisioned for this commit: stop and provision it.

```sh
node -e 'const fs = require("node:fs");
  const lock = JSON.parse(fs.readFileSync("runtime/firmware/artifacts.lock.json"));
  for (const { sha256 } of Object.values(lock.artifacts))
    fs.copyFileSync(`${process.env.RT}/artifacts/${sha256}.bin`,
      `${process.env.STACK}/artifacts/${sha256}.bin`);'
```

Never use the keys of an installed instance. Leave unset in this shell: `TBI_HOST_RUNTIME_UNIT`,
`TBI_BUILD_JOB_UNIT`, `TBI_HOST_SESSION_ROOT`, `TBI_ACCESS_VIEW`, every `TBI_HOST_SIM_*` variable
and the other service variables not named here (a set unit prefix makes the Session Host stop units
of that name at start).

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

Start them in the background of the same shell and keep each process ID.

```sh
# Build service
TBI_BUILD_LISTEN=127.0.0.1:17420 TBI_BUILD_STATE="$STACK/build-state" \
  TBI_BUILD_WORK="$STACK/build-jobs" TBI_ARTIFACT_STORE="$STACK/artifacts" \
  TBI_RUNTIME_JSON="$RT/qemu-current/runtime.json" \
  node runtime/builder/dist/build-service.mjs >"$STACK/build.log" 2>&1 &
BUILD_PID=$!

# Session Host
TBI_HOST_LISTEN=127.0.0.1:17410 TBI_HOST_STATE="$STACK/host-state" \
  TBI_ARTIFACTS="$STACK/artifacts" \
  node runtime/host/dist/session-host.mjs >"$STACK/host.log" 2>&1 &
HOST_PID=$!

# Second Session Host in reports mode (the feedback preview)
TBI_HOST_LISTEN=127.0.0.1:17411 TBI_HOST_STATE="$STACK/feedback-state" \
  TBI_ARTIFACTS="$STACK/artifacts" TBI_REPORTS_DIR="$STACK/reports" TBI_ADMIN_MODE=reports \
  TBI_OWNER_PRINCIPAL_FILE="$STACK/owner.principal" \
  node runtime/host/dist/session-host.mjs >"$STACK/feedback.log" 2>&1 &
FEEDBACK_PID=$!
```

Check that each log says `listening on` before running specs. Without `TBI_RUNTIME_JSON` the build
service announces no capabilities and refuses what needs them.

## Specs

`TBI_ADMIN_PROXY` is set because unset it falls back to `http://127.0.0.1:7410`
(`app/vite.config.ts`), which is not this stack.

```sh
CI=1 TBI_RUNTIME_PROXY=http://127.0.0.1:17410 TBI_BUILD_PROXY=http://127.0.0.1:17420 \
  TBI_FEEDBACK_RUNTIME_PROXY=http://127.0.0.1:17411 TBI_ADMIN_PROXY=http://127.0.0.1:17410 \
  TBI_S6_REAL=1 npx playwright test -c playwright.app.config.ts e2e/s6-real.spec.ts --retries=0
```

Enable further specs with their `TBI_*_REAL` variable (list in TEST-SAFETY.md). The preview proxy
plays the sign-in gate (`TBI_TEST_GATE=1`); real sign-in is not exercised. A run like this is not a
release gate result.

## Stop and clean up

Stop only your own three processes, check the ports are free, then remove `$STACK` (the owner file
inside it is root-owned; removing it from your own directory needs no `sudo`) and release the lock.

```sh
kill -TERM "$BUILD_PID" "$HOST_PID" "$FEEDBACK_PID"
wait "$BUILD_PID" "$HOST_PID" "$FEEDBACK_PID"
rm -rf -- "$STACK"
node deploy/ops/pipeline-lock.mjs release
```

## Open until rehearsed

- Whether the built-in default policy (rate and quota limits) admits a full run of all real specs.
- Whether any real spec needs the admin service (the example points `/admin-api` at the Session Host).
- Memory and CPU need on a small host.

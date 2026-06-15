# Runtime Containers

Runtime containers are the Cloud Run services that back browser terminal sessions.

## Runner Images

The default runner image is built from `session-runner/Dockerfile` and published as:

```text
us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:latest
```

The `pi-basic` runner image is built from `session-runner/Dockerfile.pi-basic` and published as:

```text
us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-basic
```

The `pi-web` runner image is built from `session-runner/Dockerfile.pi-web` and published as:

```text
us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-web
```

The `pi-n64` runner image is built from `session-runner/Dockerfile.pi-n64` and published as:

```text
us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-n64
```

The frontend image dropdown is configured in `src/config/sessionImages.js`. It contains the default runner, `pi-basic`, `pi-web`, and `pi-n64`, each with explicit capability metadata and a stable `imageKey`.

The backend is authoritative for image selection. `functions/runnerImages.helpers.js` contains the curated server-side image catalog. Session creation accepts `imageKey` and maps it to the catalog entry before provisioning Cloud Run. Legacy clients may still submit `image` only when it exactly matches a curated catalog image. Arbitrary user-supplied image URIs are rejected with `invalid_runner_image`.

## Base Environment

The image uses:

```dockerfile
FROM node:24-bookworm-slim
```

Installed OS packages currently include:

- `bash`
- `ca-certificates`
- `curl`
- `fd-find`, exposed as `fd` with a symlink to Debian's `fdfind` binary
- `git`
- `gzip`
- `openssh-client`
- `python3`
- `make`
- `g++`
- `ripgrep`
- `tar`

`curl` is intentionally installed by default because users expect it in the browser terminal, and installing it manually inside ephemeral sessions is a poor default experience.

`make` and `g++` are present because `node-pty` and terminal-adjacent dependencies may require native build support during image construction.

The default image now installs Pi Agents with:

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

Pi package installs can also require npm, git, search tools, and native build tooling depending on the package. The web extension manager runs package operations inside the active runner rather than on the client device, so it uses the same runtime toolchain that Pi uses in the terminal.

## Runner Server Layout

The container entry point is still `session-runner/server.js`, but it is now a bootstrap/router layer rather than the full runtime implementation. Feature code lives under `session-runner/lib/`:

- `terminal.js` owns PTY lifecycle, WebSocket replay, and the terminal iframe HTML.
- `preview.js` owns preview gateway modes, including pi-web static/proxy previews, pi-n64 ROM artifact previews, and the browser log buffer.
- `workspace.js` owns workspace restore, Cloud Storage sync, archive sync, GitHub workspace reconstruction, and Pi auth materialization.
- `git.js` owns Git status/actions and GitHub clone/push auth helpers.
- `pi.js` owns workspace-local Pi package and skill management.
- `activity.js`, `config.js`, `processes.js`, `services.js`, and `utils.js` hold shared runner plumbing.

Route paths, environment variables, storage paths, and startup order remain controlled by `server.js`.

## Terminal Runtime

The container runs `session-runner/server.js`.

It starts an Express server on `PORT`, serves the terminal iframe page, and exposes a WebSocket at `/terminal`. The runner keeps one active `node-pty` process per container instance. Browser WebSocket connections attach to that PTY, and closing or recreating the browser iframe detaches only the socket instead of killing the process.

The runner stores a bounded raw-output replay buffer so a newly loaded iframe can redraw recent terminal output after reconnecting. The default replay limit is `1000000` characters and can be changed with `TERMINAL_REPLAY_LIMIT`. Automatic reconnects from the same iframe skip replay to avoid duplicating visible terminal content. If the shell process itself exits, the runner closes connected sockets and the next fresh iframe connection starts a new PTY.

This persistence is scoped to the current Cloud Run container instance. A Cloud Run revision replacement, service stop, container crash, or scale-down still ends the PTY process.

The runner reports terminal activity back to the session document in Firestore. WebSocket connects and disconnects update `activeSocketCount`, `lastConnectedAt`, `lastDisconnectedAt`, and `lastActivityAt`; terminal input updates `lastActivityAt` with a short debounce to avoid one Firestore write per keystroke.

By default, that process is Pi resume mode:

```text
pi -c
```

Runtime images can set `TERMINAL_COMMAND` and optional JSON-array `TERMINAL_ARGS` to open a different terminal program. The default, `pi-basic`, `pi-web`, and `pi-n64` images set:

```text
TERMINAL_COMMAND=pi
TERMINAL_ARGS=["-c"]
```

Pi resumes from the latest saved JSONL entry. Mid-turn process, stream, or PTY state is not durable; if a Cloud Run instance stops during an active turn, the next terminal starts from the last completed Pi session entry. Users who want a fresh Pi conversation can type `/new` in the Pi TUI.

The browser terminal uses `@xterm/xterm` instead of a plain text `<div>`. This is important because PTY output includes ANSI escape sequences, cursor movement, alternate screen buffers, colors, and TUI control codes. Rendering raw PTY output as text caused artifacts such as `[0m[2m-`.

## Pi Basic Runtime

`session-runner/Dockerfile.pi-basic` starts from the same Pi-oriented base image and package set as the default runner.

The image sets `TERMINAL_COMMAND=pi` and `TERMINAL_ARGS=["-c"]`, so new browser terminal connections open Pi in resume mode instead of a login shell or fresh conversation.

The skills manager targets `pi-basic` first. Skill listing and mutations require a running session so the manager can write the same `/workspace/.pi/skills/{skill-name}/SKILL.md` files that Pi discovers at startup.

The planned extension manager targets `pi-basic` first. For v1, package listing and package mutations can require a running `pi-basic` session so the manager can operate on the same `/workspace/.pi/settings.json` and package cache directories that Pi uses.

Build and push the image with:

```bash
gcloud builds submit session-runner \
  --config session-runner/cloudbuild.pi-basic.yaml
```

## Pi Web Runtime

`session-runner/Dockerfile.pi-web` is the web-development runner. It starts from the same Pi-oriented shape as `pi-basic`, then adds Chromium and globally installed Playwright test tooling for browser QA. The image sets the runner capability contract to:

```json
{"terminal":true,"preview":true,"previewQa":true,"functions":true}
```

The shared runner server still owns the terminal, sync, protected shutdown, Git, skill, and package endpoints. Web behavior is enabled by environment:

- `PREVIEW_ENABLED=true`
- `PREVIEW_BASE_PATH=/preview`
- `PREVIEW_STATIC_ROOT=/workspace/build`
- `PREVIEW_INJECT_LOGGER=true`
- `PREVIEW_LOG_LIMIT=500`
- `MAPACHE_RUNNER_URL=http://127.0.0.1:8080`
- `MAPACHE_PREVIEW_URL=http://127.0.0.1:8080/preview/`
- `MAPACHE_QA_DIR=/workspace/.mapache/qa`

When preview is enabled, the runner exposes:

- `GET /capabilities` for live runtime capability discovery.
- `GET /preview/status` for static preview readiness.
- `GET /preview/logs` for the in-memory browser console log ring buffer.
- `GET /preview/logs/stream` for server-sent browser console log events.
- `POST /preview/logs` for the injected browser logger.
- `GET /preview/*` for static files under `/workspace/build` with SPA fallback to `index.html`.

HTML responses from the static preview receive a small development logger script when `PREVIEW_INJECT_LOGGER=true`. It forwards `console.log`, `console.info`, `console.warn`, `console.error`, `window.onerror`, and unhandled promise rejections to the runner log buffer. QA agents can combine these logs with Playwright screenshots and interaction checks without needing to scrape the terminal.

Agents can switch the preview gateway from static-file serving to a local app/API server by writing `/workspace/.mapache/preview.json`:

```json
{
  "mode": "proxy",
  "upstream": "http://127.0.0.1:3000"
}
```

Only localhost upstreams are accepted. In proxy mode, `/preview/*` forwards HTTP methods and paths to the upstream server, so a framework dev server, Express app, or function emulator can serve both browser routes and API routes through the same Preview canvas. Removing the file, or setting `mode` to `static`, returns the preview to static serving from `/workspace/build` or the configured `staticRoot`.

On startup, `pi-web` seeds three workspace-local Pi skills when they are missing:

- `mapache-preview-build`
- `mapache-api-hosting`
- `mapache-preview-qa`

These files are written under `/workspace/.pi/skills/{skill-name}/SKILL.md` after workspace restore and before the Pi terminal process starts, so Pi can discover them in new `pi-web` sessions. Existing user-edited skills with the same names are not overwritten.

Build and push the image with:

```bash
gcloud builds submit session-runner \
  --config session-runner/cloudbuild.pi-web.yaml
```

## Pi N64 Runtime

`session-runner/Dockerfile.pi-n64` is the Nintendo 64 homebrew runner. It starts from the same Pi-oriented shape as `pi-basic`, then installs the libdragon prebuilt MIPS64 toolchain Debian package, builds libdragon from the `trunk` branch, and installs libdragon and its host tools into `/opt/libdragon`.

The image sets the runner capability contract to:

```json
{"terminal":true,"preview":true,"previewQa":false,"functions":false,"n64":true}
```

The shared runner server still owns the terminal, sync, protected shutdown, Git, skill, and package endpoints. N64 behavior is enabled by environment:

- `PREVIEW_ENABLED=true`
- `PREVIEW_BASE_PATH=/preview`
- `PREVIEW_STATIC_ROOT=/workspace/build`
- `PREVIEW_N64_ROM_PATH=/workspace/build/game.z64`
- `MAPACHE_RUNNER_URL=http://127.0.0.1:8080`
- `MAPACHE_PREVIEW_URL=http://127.0.0.1:8080/preview/`
- `N64_INST=/opt/libdragon`

When the runner has the `n64` capability, the preview gateway defaults to `mode: "n64"` if `/workspace/.mapache/preview.json` is missing. In N64 mode:

- `GET /preview/` serves a Mapache-owned EmulatorJS shell. If the ROM exists, the shell loads the ROM from `/preview/rom.z64`; if it does not, the page shows a waiting state with the expected path.
- `GET /preview/rom.z64` serves the ROM at `PREVIEW_N64_ROM_PATH`.
- `GET /preview/status` reports `mode: "n64"`, the selected emulator core, whether the ROM exists, its byte size, and the ROM URL.

Agents can override the ROM path and emulator core by writing `/workspace/.mapache/preview.json`:

```json
{
  "mode": "n64",
  "rom": "build/custom.z64",
  "core": "mupen64plus_next"
}
```

Only `.z64`, `.n64`, and `.v64` files inside `/workspace` are accepted. The core can be `n64`, `mupen64plus_next`, or `parallel-n64`; invalid values fall back to `n64`. The browser shell uses EmulatorJS from the stable CDN and keeps `/preview/rom.z64` as the stable ROM artifact URL for downloads and external emulator checks.

On startup, `pi-n64` seeds two workspace-local Pi skills when they are missing:

- `mapache-n64-build`: explains how to build/package a homebrew ROM to `/workspace/build/game.z64`.
- `mapache-n64-preview`: explains the N64 browser emulator shell, status endpoint, ROM endpoint, and optional core override.

These files are written under `/workspace/.pi/skills/{skill-name}/SKILL.md` after workspace restore and before the Pi terminal process starts, so Pi can discover them in new `pi-n64` sessions. Existing user-edited skills with the same names are not overwritten.

Build and push the image with:

```bash
gcloud builds submit session-runner \
  --config session-runner/cloudbuild.pi-n64.yaml
```

## Workspace Sync

Each container uses `/workspace` as its working directory.

The runner can sync files from Cloud Storage before serving the terminal and periodically upload workspace contents back to Cloud Storage. The sync destination is controlled by environment variables:

- `STORAGE_BUCKET`
- `STORAGE_PREFIX`
- `PI_HOME_STORAGE_BUCKET`
- `PI_HOME_STORAGE_PREFIX`
- `WORKSPACE_ID`
- `SESSION_ID`
- `SYNC_INTERVAL_MS`, defaulting to `30000`
- `ARCHIVE_SYNC_INTERVAL_MS`, defaulting to `300000`

The backend sets these when provisioning the Cloud Run session service.
`STORAGE_BUCKET` comes from the workspace record when present, then falls back to `SESSION_BUCKET`, then Firebase's configured default `storageBucket`.

GitHub-backed sessions also receive source metadata env vars for runner startup and later Git-aware behavior:

- `WORKSPACE_SOURCE_TYPE=github`
- `GITHUB_REPO_URL`
- `GITHUB_REPO_OWNER`
- `GITHUB_REPO_NAME`
- `GITHUB_REQUESTED_BRANCH`
- `GITHUB_REQUESTED_COMMIT`
- `GITHUB_RESOLVED_BRANCH`
- `GITHUB_RESOLVED_COMMIT`
- `GITHUB_CHECKOUT_REF`

Private connected-repo sessions now also receive a short-lived installation token pair for clone-only auth:

- `GITHUB_CLONE_USERNAME`
- `GITHUB_CLONE_TOKEN`

The backend mints those values only while provisioning or restarting the runner. They are not written to Firestore, not synced into `/workspace`, and the runner uses them only through a temporary `GIT_ASKPASS` helper outside the workspace tree.

Blank workspaces continue using the existing storage-oriented env setup, with `WORKSPACE_SOURCE_TYPE=blank` so the runner can detect mode without guessing.

Workspace records also carry an app-owned `syncPolicy` field. Blank workspaces default to `mode: "blank"` with no exclusions. GitHub workspaces default to `mode: "github-cache"` and exclude `.git/`, `node_modules/`, build outputs, `.next/`, and `.mapahce-internal/` paths from normal file sync.

The backend passes that policy into the runner with:

- `WORKSPACE_SYNC_POLICY_MODE`
- `WORKSPACE_SYNC_POLICY_EXCLUDE` (JSON array)

Normal upload/download sync now applies base exclusions for archive-backed/internal paths plus any `syncPolicy.exclude` entries. That keeps blank workspace behavior effectively unchanged while letting GitHub workspaces skip extra cached paths during ordinary file sync. Directory marker objects still apply for non-excluded directories.

The browser sidebar lists workspace files from Cloud Storage through the Cloud Functions API, not directly from a running session container. `GET /api/workspaces/{workspaceId}/files` validates workspace ownership and lists objects under the workspace `storagePrefix`, so the Files section reflects the latest synced objects even when no terminal iframe is selected. Running containers still control when local `/workspace` changes are uploaded; by default `session-runner/server.js` syncs regular workspace files every 30 seconds.

The sidebar upload action writes directly to that same Cloud Storage prefix through Cloud Functions with `POST /api/workspaces/{workspaceId}/file?path={filename}`. This makes browser-uploaded files immediately visible to future sessions and to the Files listing after refresh. A currently running container will see the uploaded object only after it restarts or otherwise runs a storage-to-workspace restore; local files created inside a running terminal still flow in the opposite direction through the runner's periodic sync-up.

This behavior now needs to be read together with workspace source mode:

- For `blank` workspaces, Cloud Storage remains the durable source of truth.
- For `github` workspaces, Cloud Storage is a cache and resumability layer for the last active local state. GitHub is the durable repository source of truth.

Cloud Storage does not store real directories, so the runner uploads a `.mapahce-directory` marker object inside each synced directory. The Files API maps those marker objects to `type: "directory"` entries and filters them out of the displayed file list. Existing Cloud Run sessions need a new runner revision before empty directories can appear in the sidebar.

High-cardinality runtime directories are not synced as individual Cloud Storage objects:

- `/workspace/node_modules`
- `/workspace/.git` for GitHub-backed workspaces
- `/root/.pi`

The Pi extension manager extends this model to workspace-local Pi package cache directories:

- `/workspace/.pi/npm` archived as `.mapahce-internal/archives/workspace-pi-npm.tar.gz`
- `/workspace/.pi/git` archived as `.mapahce-internal/archives/workspace-pi-git.tar.gz`

The portable package declaration file, `/workspace/.pi/settings.json`, remains normal workspace file state. Package install directories are runtime cache state and are archived under `.mapahce-internal/archives/` instead of uploaded object-by-object. Normal workspace sync skips `.pi/npm/` and `.pi/git/`, while the Files API and editor routes hide those cache paths and the internal archive objects.

The runner restores these directories from gzip-compressed tar archives during startup and uploads them as single archive objects on the slower archive sync interval. It also forces an archive upload during the protected shutdown sync before a session service is deleted.

`/workspace/node_modules` and `/workspace/.git` remain workspace-scoped. Their archives live under `.mapahce-internal/archives/` inside the workspace storage prefix, and the Files API hides that internal directory from the sidebar and editor routes.

`/root/.pi` is user-scoped so Pi auth and agent state follow the authenticated user across workspaces. The backend passes `PI_HOME_STORAGE_BUCKET` and `PI_HOME_STORAGE_PREFIX`; new sessions store the archive under `users/{uid}/.mapahce-internal/pi-home/root-pi.tar.gz`. During restore, the runner first checks the user-scoped archive and then falls back to the old workspace-scoped archive path so existing auth can migrate on the next archive upload.

Pi provider auth is also mirrored in Firestore at `users/{uid}/private/piAuth` under a `providers` map whose entries match Pi's `~/.pi/agent/auth.json` object shape exactly (`providerKey -> credential object`). The backend API writes web-added API keys as `{type: "api_key", key: "..."}`. It also supports OpenAI ChatGPT Plus/Pro Codex subscription login through OpenAI's device-code flow and saves the completed credential under `openai-codex` as `{type: "oauth", access, refresh, expires, accountId}`. The runner receives `OWNER_UID`, reads any restored/local `auth.json` entries into that Firestore map, and materializes the merged Firestore providers back into `~/.pi/agent/auth.json` with `0600` permissions on startup and during periodic sync. The backend also sets `PI_CODING_AGENT_DIR=/root/.pi/agent` so Pi resolves auth storage to the same file path. This makes CLI/TUI `/login` additions visible to the web UI after runner sync while letting web-added credentials appear in already-running sessions after the runner sync interval.

For GitHub workspaces, treating `/workspace/.git` as archive-backed state is also a consistency boundary. The app should not expose Git internals through normal file listing or per-file object sync. Restoring `.git` from a single archive is safer than trying to mirror Git internals as ordinary Cloud Storage objects. Normal sync now skips `.git` paths for GitHub workspaces, and archive upload stores `.git` under the hidden internal archive prefix while skipping obvious transient `*.lock` files where practical. Dedicated startup restore ordering for `.git` remains a later task.

This keeps dependency installs, Git metadata, and Pi Agent state available without creating thousands of Cloud Storage objects for `node_modules` or `.git`. Archive-backed changes can lag normal file sync by up to `ARCHIVE_SYNC_INTERVAL_MS` unless the session is stopped cleanly, which triggers the final archive sync.

The detailed GitHub workspace architecture, including one-active-session enforcement and cache semantics, lives in [github-workspaces.md](./github-workspaces.md).

The planned Pi extension manager architecture, including workspace-local package scope, package catalog metadata, write locations, and active-session behavior, lives in [pi-extension-manager.md](./pi-extension-manager.md).

### GitHub Workspace Reconstruction

GitHub-backed workspaces should reconstruct `/workspace` in this order:

1. Restore cached `.git` archive when present.
2. If no cached Git state exists, clone the repository and check out the requested commit or branch.
3. Restore cached worktree files from Cloud Storage, excluding ignored and internal paths.
4. Restore other archive-backed runtime directories such as `node_modules` and `/root/.pi`.
5. Validate and publish Git runtime state before serving the terminal.

The current runner implementation now follows that startup order for GitHub workspaces. It first checks for a cached `.git` archive under the hidden archive prefix and restores it when present. If no cached Git archive exists, or the archive restores without a valid `HEAD`, it clones the repository and uses `GITHUB_REQUESTED_BRANCH` for branch-targeted clones when no exact commit is pinned, then forces `git checkout` to `GITHUB_REQUESTED_COMMIT` when an exact commit is provided. Public repos still clone anonymously. Private connected repos now clone with a short-lived GitHub App installation token supplied by the backend at provisioning time, passed through a temporary `GIT_ASKPASS` script so the token is not embedded into the repo remote config or workspace files. After Git state is available, the runner restores cached worktree files, restores the other archive-backed directories such as `node_modules` and `/root/.pi`, resolves the current `HEAD` commit, and writes runtime metadata back to both the session document and workspace `source` fields. That update is limited to runtime-derived fields such as resolved branch/commit and source status so user-selected repo settings are not overwritten. Missing or invalid `.git` cache is handled as a normal clone fallback. Failure logs now identify whether startup broke during Git archive restore, clone, checkout, or later cache/worktree restore, while user-facing runtime status still distinguishes clone auth, repo-not-found, network, and later sync failures.

Deleted worktree files are important here. A GitHub workspace cannot rely on upload-only file sync. If a file was deleted locally, the cached copy in Cloud Storage must be removed or invalidated so it does not reappear on the next restore.

The current runner implementation now does that reconciliation for GitHub workspaces during normal sync: after uploading the current non-ignored worktree files and directory markers, it deletes stale non-internal Cloud Storage objects that are no longer part of the desired worktree cache. Blank workspaces still keep the older upload-only behavior.

## Provisioning

When a session is created, `functions/index.js` stores the session record and provisions a Cloud Run service using the selected curated image. The create-session payload should include `imageKey`; the backend resolves that key through `functions/runnerImages.helpers.js` and stores both `imageKey` and the resolved `image` URI on the session. If no image key is present, the backend uses the operator-controlled `SESSION_RUNNER_IMAGE` default. Direct user-provided image URIs are not accepted unless they exactly match a curated catalog image for legacy client compatibility.

Each session service is named with the session id:

```text
session-<lowercase-session-id>
```

Cloud Run resource limits are derived from the session's CPU and memory settings.

Stopping a running session from the sidebar calls the backend stop route for that session. The backend deletes the per-session Cloud Run service, which terminates the `session-runner` container, then updates the Firestore session record to `stopped` and clears `serviceUrl`. If the Cloud Run service is already gone, the session is still marked stopped. Deleting a session from the sidebar uses the same service deletion path for any still-running service, then removes the session document from Firestore so it no longer appears in the workspace session list.

Before deleting a service, the backend calls the runner's protected `POST /shutdown` endpoint when the session has a `serviceUrl` and `shutdownToken`. The runner performs one final workspace sync, including archive-backed directories, and records `shutdownRequestedAt`; the backend still proceeds with deletion if this best-effort request fails. Older sessions without a shutdown token skip this step.

When a session reaches the stopped path, the backend records an allocated usage interval under `users/{uid}/sessionUsage/{sessionId}` and marks the session with `usageAccountedAt`. The interval uses the session's `createdAt` to `stoppedAt` runtime multiplied by the configured Cloud Run CPU and memory limits, producing CPU seconds and memory GiB-seconds for the profile page. Resize operations accrue usage through the resize timestamp before changing the session's resource limits, so lifetime totals account for resource changes within a session. Running sessions and older stopped sessions without `usageAccountedAt` are still included dynamically by `/api/me`, so the profile can show lifetime and trailing-30-day usage without enforcing quotas. These counters intentionally do not use Cloud Monitoring utilization or billing-export data.

Usage reads depend on collection group indexes in `firestore.indexes.json`. The profile API queries `workspaces/{workspaceId}/sessions` by `ownerUid` to include running and unaccounted sessions, and admin-wide reporting can query `users/{uid}/sessionUsage` by `ownerUid` or `endedAt` to aggregate across users and trailing windows.

The runner also exposes protected Git endpoints that use the same token gate. `GET /git/status` derives branch, commit, ahead/behind, dirty counts, conflicted state, and changed file entries from Git commands inside `/workspace`. `POST /git/pull` runs a fixed fetch/pull flow for GitHub workspaces and returns updated Git state afterward. `POST /git/stage` and `POST /git/unstage` accept validated workspace-relative paths only, so the backend/UI can stage or unstage changed files without exposing arbitrary command execution. `POST /git/commit` accepts a validated commit message, rejects empty commits, and returns updated Git state plus the committed head SHA. `POST /git/push` pushes the current branch when runner credentials are configured, currently via `GITHUB_PUSH_TOKEN` and optional `GITHUB_PUSH_USERNAME`; if those credentials are missing, the endpoint returns a clear auth-not-configured error instead of logging secrets. For blank workspaces these endpoints return a structured non-Git response instead of pretending Cloud Storage state is a repository.

The skill endpoints follow the same protected-runner pattern. Cloud Functions verifies workspace/session ownership, then proxies skill list/save/delete requests to the runner with its protected token. The runner serializes skill file mutations, writes Markdown under `/workspace/.pi/skills`, and runs normal workspace sync afterward.

The planned package endpoints should follow the same protected-runner pattern. Cloud Functions verifies workspace/session ownership, then proxies package list/install/remove/update requests to the runner with its protected token. The runner should serialize package operations and operate on workspace-local Pi settings by default.

For GitHub workspaces, this final sync is especially important because it is the last chance to persist local working tree changes and refreshed `.git` archive state before the Cloud Run service disappears.

The shutdown request timeout defaults to 120 seconds because archive-backed dependency directories can be large. New deployments can override it with `RUNNER_SHUTDOWN_TIMEOUT_MS`.

## Idle Shutdown

Sessions automatically stop after a period without a connected browser terminal. New session records store:

- `activeSocketCount`
- `lastActivityAt`
- `lastConnectedAt`
- `lastDisconnectedAt`
- `idleTimeoutMinutes`
- `shutdownToken`

The default idle timeout is 60 minutes and can be changed for new sessions with the Cloud Functions environment variable `SESSION_IDLE_TIMEOUT_MINUTES`. The reaper caps each session's effective timeout at the current backend default, so older session records with a larger stored `idleTimeoutMinutes` value do not keep containers alive longer than the active default.

The scheduled Cloud Function `reapIdleSessions` runs every 5 minutes. It scans running session documents, treats a session as idle when the latest terminal activity timestamp is older than `idleTimeoutMinutes`, then reuses the same Cloud Run deletion flow as manual stop. Terminal activity includes terminal connect, disconnect, user input, and shell output; `activeSocketCount` is still recorded for visibility, but it is not allowed to keep a silent container alive forever. Idle-stopped sessions are marked with `stopReason: "idle_timeout"` and `autoStoppedAt`.

Idle is defined as no terminal I/O or connection lifecycle activity. A long-running command that continues producing output keeps the session active. If the browser is left open without terminal I/O past the timeout, or is closed/disconnected past the timeout, the session service is deleted.

## Existing Sessions vs New Sessions

Pushing a new `:latest` image affects new pulls, but existing Cloud Run services need a new revision to pick it up. For an existing session service, update the service image to create a fresh revision:

```bash
gcloud run services update SERVICE_NAME \
  --image us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:latest \
  --region us-central1 \
  --project pi-agents-cloud
```

New sessions use the image key selected in the modal and resolved by the backend. Existing sessions keep their current image until the Cloud Run service is updated or the session is recreated.

Existing services created before idle shutdown support do not have `SESSION_SHUTDOWN_TOKEN` in their environment and may not run runner code that reports activity. Recreate or update those Cloud Run services to pick up automatic activity reporting and best-effort final sync on stop.

The same rule applies to new GitHub workspace source env vars, sync-policy env vars, Pi skill endpoints, Pi package manager endpoints, Pi package archive targets, and terminal defaults. Existing Cloud Run services do not automatically gain `WORKSPACE_SOURCE_TYPE`, `GITHUB_*`, `WORKSPACE_SYNC_POLICY_*`, `/pi/skills*`, `/pi/packages*` runner routes, `.pi/npm`/`.pi/git` archive behavior, or the `pi -c` resume default; they need a new revision or a recreated session service before runner changes that depend on those variables, routes, or image `ENV` values will take effect.

When `functions/` changes are part of the package manager work, deploy Cloud Functions before handoff unless explicitly skipped:

```bash
firebase deploy --only functions --project pi-agents-cloud
```

Expected package-manager write locations:

- Workspace package declarations: `{workspace.storagePrefix}/.pi/settings.json`
- Workspace package cache archives: `{workspace.storagePrefix}/.mapahce-internal/archives/workspace-pi-npm.tar.gz` and `workspace-pi-git.tar.gz`
- User-scoped Pi home archive: `users/{uid}/.mapahce-internal/pi-home/root-pi.tar.gz`
- User package catalog: `users/{uid}/piPackageCatalog/{encodedPackageIdentity}`

## Design Decisions

- Browser terminals should use a real terminal emulator. The app uses xterm.js so terminal programs and shell formatting render correctly.
- The runner keeps the PTY alive across WebSocket disconnects so frontend re-renders, iframe reloads, and brief network drops do not discard in-progress terminal work.
- Idle shutdown is controlled by Cloud Functions instead of browser timers so abandoned sessions are cleaned up even after the browser is closed.
- Runtime image selection is user-facing but backend-enforced. The UI exposes curated image keys, and Cloud Functions rejects arbitrary image URIs from normal session creation. Bring-your-own-image support, if added later, should be a separate permission-gated untrusted-workload path rather than an extension of the normal image selector.
- Containers include common developer tools by default when they are broadly expected in terminal workflows.
- Image-specific startup should be controlled by environment variables in the image where possible. This keeps the runner server shared while allowing curated runtimes such as `pi-basic` to open a different PTY command.
- Large generated runtime directories should use archive-backed sync instead of object-per-file Cloud Storage sync. This avoids slow file listings and excessive object counts for directories such as `node_modules`.
- GitHub workspaces should archive `/workspace/.git` instead of exposing it through normal file sync. That keeps Git state resumable without treating Cloud Storage as a Git database.
- Workspace-local Pi skills should remain ordinary workspace Markdown files under `/workspace/.pi/skills`.
- Workspace-local Pi package install directories should use archive-backed sync while `/workspace/.pi/settings.json` remains normal workspace configuration.
- GitHub workspaces should allow only one active session at a time until the app has an explicit multi-session Git isolation model.
- Existing sessions are not automatically recycled when the image config changes. This avoids surprising users by restarting active terminals.

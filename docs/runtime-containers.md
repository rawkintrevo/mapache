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

The frontend image dropdown is configured in `src/config/sessionImages.js`. It contains the default runner and `pi-basic`.

## Base Environment

The image uses:

```dockerfile
FROM node:24-bookworm-slim
```

Installed OS packages currently include:

- `bash`
- `ca-certificates`
- `curl`
- `git`
- `gzip`
- `openssh-client`
- `python3`
- `make`
- `g++`
- `tar`

`curl` is intentionally installed by default because users expect it in the browser terminal, and installing it manually inside ephemeral sessions is a poor default experience.

`make` and `g++` are present because `node-pty` and terminal-adjacent dependencies may require native build support during image construction.

## Terminal Runtime

The container runs `session-runner/server.js`.

It starts an Express server on `PORT`, serves the terminal iframe page, and exposes a WebSocket at `/terminal`. The runner keeps one active `node-pty` process per container instance. Browser WebSocket connections attach to that PTY, and closing or recreating the browser iframe detaches only the socket instead of killing the process.

The runner stores a bounded raw-output replay buffer so a newly loaded iframe can redraw recent terminal output after reconnecting. The default replay limit is `1000000` characters and can be changed with `TERMINAL_REPLAY_LIMIT`. Automatic reconnects from the same iframe skip replay to avoid duplicating visible terminal content. If the shell process itself exits, the runner closes connected sockets and the next fresh iframe connection starts a new PTY.

This persistence is scoped to the current Cloud Run container instance. A Cloud Run revision replacement, service stop, container crash, or scale-down still ends the PTY process.

The runner reports terminal activity back to the session document in Firestore. WebSocket connects and disconnects update `activeSocketCount`, `lastConnectedAt`, `lastDisconnectedAt`, and `lastActivityAt`; terminal input updates `lastActivityAt` with a short debounce to avoid one Firestore write per keystroke.

By default, that process is the login shell:

```text
bash -l
```

Runtime images can set `TERMINAL_COMMAND` and optional JSON-array `TERMINAL_ARGS` to open a different terminal program. The `pi-basic` image sets:

```text
TERMINAL_COMMAND=pi
```

The browser terminal uses `@xterm/xterm` instead of a plain text `<div>`. This is important because PTY output includes ANSI escape sequences, cursor movement, alternate screen buffers, colors, and TUI control codes. Rendering raw PTY output as text caused artifacts such as `[0m[2m-`.

## Pi Basic Runtime

`session-runner/Dockerfile.pi-basic` starts from the same base image and package set as the default runner, then installs Pi Agents with:

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

It also adds search tools for terminal-first coding workflows:

- `fd-find`, exposed as `fd` with a symlink to Debian's `fdfind` binary
- `ripgrep`

The image sets `TERMINAL_COMMAND=pi`, so new browser terminal connections open Pi directly instead of a login shell.

Build and push the image with:

```bash
gcloud builds submit session-runner \
  --config session-runner/cloudbuild.pi-basic.yaml
```

## Workspace Sync

Each container uses `/workspace` as its working directory.

The runner can sync files from Cloud Storage before serving the terminal and periodically upload workspace contents back to Cloud Storage. The sync destination is controlled by environment variables:

- `STORAGE_BUCKET`
- `STORAGE_PREFIX`
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

Blank workspaces continue using the existing storage-oriented env setup, with `WORKSPACE_SOURCE_TYPE=blank` so the runner can detect mode without guessing.

Workspace records also carry an app-owned `syncPolicy` field. Blank workspaces default to `mode: "blank"` with no exclusions. GitHub workspaces default to `mode: "github-cache"` and exclude `.git/`, `node_modules/`, build outputs, `.next/`, and `.mapahce-internal/` paths from normal file sync.

The backend passes that policy into the runner with:

- `WORKSPACE_SYNC_POLICY_MODE`
- `WORKSPACE_SYNC_POLICY_EXCLUDE` (JSON array)

Normal upload/download sync now applies base exclusions for archive-backed/internal paths plus any `syncPolicy.exclude` entries. That keeps blank workspace behavior effectively unchanged while letting GitHub workspaces skip extra cached paths during ordinary file sync. Directory marker objects still apply for non-excluded directories.

The browser sidebar lists workspace files from Cloud Storage through the Cloud Functions API, not directly from a running session container. `GET /api/workspaces/{workspaceId}/files` validates workspace ownership and lists objects under the workspace `storagePrefix`, so the Files section reflects the latest synced objects even when no terminal iframe is selected. Running containers still control when local `/workspace` changes are uploaded; by default `session-runner/server.js` syncs regular workspace files every 30 seconds.

This behavior now needs to be read together with workspace source mode:

- For `blank` workspaces, Cloud Storage remains the durable source of truth.
- For `github` workspaces, Cloud Storage is a cache and resumability layer for the last active local state. GitHub is the durable repository source of truth.

Cloud Storage does not store real directories, so the runner uploads a `.mapahce-directory` marker object inside each synced directory. The Files API maps those marker objects to `type: "directory"` entries and filters them out of the displayed file list. Existing Cloud Run sessions need a new runner revision before empty directories can appear in the sidebar.

High-cardinality runtime directories are not synced as individual Cloud Storage objects:

- `/workspace/node_modules`
- `/workspace/.git` for GitHub-backed workspaces
- `/root/.pi`

The runner restores these directories from gzip-compressed tar archives during startup and uploads them as single archive objects on the slower archive sync interval. It also forces an archive upload during the protected shutdown sync before a session service is deleted. Archive objects live under `.mapahce-internal/archives/` inside the workspace storage prefix, and the Files API hides that internal directory from the sidebar and editor routes.

For GitHub workspaces, treating `/workspace/.git` as archive-backed state is also a consistency boundary. The app should not expose Git internals through normal file listing or per-file object sync. Restoring `.git` from a single archive is safer than trying to mirror Git internals as ordinary Cloud Storage objects. Normal sync now skips `.git` paths for GitHub workspaces, and archive upload stores `.git` under the hidden internal archive prefix while skipping obvious transient `*.lock` files where practical. Dedicated startup restore ordering for `.git` remains a later task.

This keeps dependency installs, Git metadata, and Pi Agent state available to later sessions without creating thousands of Cloud Storage objects for `node_modules` or `.git`. It also means archive-backed changes can lag normal file sync by up to `ARCHIVE_SYNC_INTERVAL_MS` unless the session is stopped cleanly, which triggers the final archive sync.

The detailed GitHub workspace architecture, including one-active-session enforcement and cache semantics, lives in [github-workspaces.md](./github-workspaces.md).

### GitHub Workspace Reconstruction

GitHub-backed workspaces should reconstruct `/workspace` in this order:

1. Restore cached `.git` archive when present.
2. If no cached Git state exists, clone the repository and check out the requested commit or branch.
3. Restore cached worktree files from Cloud Storage, excluding ignored and internal paths.
4. Restore other archive-backed runtime directories such as `node_modules` and `/root/.pi`.
5. Validate and publish Git runtime state before serving the terminal.

The current runner implementation now follows that startup order for GitHub workspaces. It first checks for a cached `.git` archive under the hidden archive prefix and restores it when present. If no cached Git archive exists, it clones the public repository and uses `GITHUB_REQUESTED_BRANCH` for branch-targeted clones when no exact commit is pinned, then forces `git checkout` to `GITHUB_REQUESTED_COMMIT` when an exact commit is provided. After Git state is available, the runner restores cached worktree files, restores the other archive-backed directories such as `node_modules` and `/root/.pi`, resolves the current `HEAD` commit, and writes runtime metadata back to both the session document and workspace `source` fields. That update is limited to runtime-derived fields such as resolved branch/commit and source status so user-selected repo settings are not overwritten. Missing `.git` cache is handled as a normal clone fallback. Failure logs now identify whether startup broke during Git archive restore, clone, checkout, or later cache/worktree restore, while user-facing runtime status still distinguishes `clone_failed` from `sync_failed`.

Deleted worktree files are important here. A GitHub workspace cannot rely on upload-only file sync. If a file was deleted locally, the cached copy in Cloud Storage must be removed or invalidated so it does not reappear on the next restore.

The current runner implementation now does that reconciliation for GitHub workspaces during normal sync: after uploading the current non-ignored worktree files and directory markers, it deletes stale non-internal Cloud Storage objects that are no longer part of the desired worktree cache. Blank workspaces still keep the older upload-only behavior.

## Provisioning

When a session is created, `functions/index.js` stores the session record and provisions a Cloud Run service using the selected image. The image value comes from the create-session payload when present, or from the backend `SESSION_RUNNER_IMAGE` default.

Each session service is named with the session id:

```text
session-<lowercase-session-id>
```

Cloud Run resource limits are derived from the session's CPU and memory settings.

Stopping a running session from the sidebar calls the backend stop route for that session. The backend deletes the per-session Cloud Run service, which terminates the `session-runner` container, then updates the Firestore session record to `stopped` and clears `serviceUrl`. If the Cloud Run service is already gone, the session is still marked stopped.

Before deleting a service, the backend calls the runner's protected `POST /shutdown` endpoint when the session has a `serviceUrl` and `shutdownToken`. The runner performs one final workspace sync, including archive-backed directories, and records `shutdownRequestedAt`; the backend still proceeds with deletion if this best-effort request fails. Older sessions without a shutdown token skip this step.

The runner also exposes protected Git endpoints that use the same token gate. `GET /git/status` derives branch, commit, ahead/behind, dirty counts, and conflicted state from Git commands inside `/workspace`. `POST /git/pull` runs a fixed fetch/pull flow for GitHub workspaces and returns updated Git state afterward. For blank workspaces these endpoints return a structured non-Git response instead of pretending Cloud Storage state is a repository.

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

The default idle timeout is 60 minutes and can be changed for new sessions with the Cloud Functions environment variable `SESSION_IDLE_TIMEOUT_MINUTES`.

The scheduled Cloud Function `reapIdleSessions` runs every 5 minutes. It scans running session documents, treats a session as idle when `activeSocketCount` is `0` and the latest disconnect or activity timestamp is older than `idleTimeoutMinutes`, then reuses the same Cloud Run deletion flow as manual stop. Idle-stopped sessions are marked with `stopReason: "idle_timeout"` and `autoStoppedAt`.

Idle is defined as no connected terminal client, not no shell output. A long-running command continues while the browser terminal remains connected. If the browser is closed or disconnected past the timeout, the session service is deleted.

## Existing Sessions vs New Sessions

Pushing a new `:latest` image affects new pulls, but existing Cloud Run services need a new revision to pick it up. For an existing session service, update the service image to create a fresh revision:

```bash
gcloud run services update SERVICE_NAME \
  --image us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:latest \
  --region us-central1 \
  --project pi-agents-cloud
```

New sessions use the image selected in the modal. Existing sessions keep their current image until the Cloud Run service is updated or the session is recreated.

Existing services created before idle shutdown support do not have `SESSION_SHUTDOWN_TOKEN` in their environment and may not run runner code that reports activity. Recreate or update those Cloud Run services to pick up automatic activity reporting and best-effort final sync on stop.

The same rule applies to new GitHub workspace source env vars and sync-policy env vars. Existing Cloud Run services do not automatically gain `WORKSPACE_SOURCE_TYPE`, `GITHUB_*`, or `WORKSPACE_SYNC_POLICY_*` env vars; they need a new revision or a recreated session service before runner changes that depend on those variables will take effect.

## Design Decisions

- Browser terminals should use a real terminal emulator. The app uses xterm.js so terminal programs and shell formatting render correctly.
- The runner keeps the PTY alive across WebSocket disconnects so frontend re-renders, iframe reloads, and brief network drops do not discard in-progress terminal work.
- Idle shutdown is controlled by Cloud Functions instead of browser timers so abandoned sessions are cleaned up even after the browser is closed.
- Runtime image selection is user-facing but config-controlled. This prevents arbitrary image entry in the UI while keeping the path open for curated images.
- Containers include common developer tools by default when they are broadly expected in terminal workflows.
- Image-specific startup should be controlled by environment variables in the image where possible. This keeps the runner server shared while allowing curated runtimes such as `pi-basic` to open a different PTY command.
- Large generated runtime directories should use archive-backed sync instead of object-per-file Cloud Storage sync. This avoids slow file listings and excessive object counts for directories such as `node_modules`.
- GitHub workspaces should archive `/workspace/.git` instead of exposing it through normal file sync. That keeps Git state resumable without treating Cloud Storage as a Git database.
- GitHub workspaces should allow only one active session at a time until the app has an explicit multi-session Git isolation model.
- Existing sessions are not automatically recycled when the image config changes. This avoids surprising users by restarting active terminals.

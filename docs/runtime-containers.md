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
- `openssh-client`
- `python3`
- `make`
- `g++`

`curl` is intentionally installed by default because users expect it in the browser terminal, and installing it manually inside ephemeral sessions is a poor default experience.

`make` and `g++` are present because `node-pty` and terminal-adjacent dependencies may require native build support during image construction.

## Terminal Runtime

The container runs `session-runner/server.js`.

It starts an Express server on `PORT`, serves the terminal iframe page, and exposes a WebSocket at `/terminal`. The runner keeps one active `node-pty` process per container instance. Browser WebSocket connections attach to that PTY, and closing or recreating the browser iframe detaches only the socket instead of killing the process.

The runner stores a bounded raw-output replay buffer so a newly loaded iframe can redraw recent terminal output after reconnecting. The default replay limit is `1000000` characters and can be changed with `TERMINAL_REPLAY_LIMIT`. Automatic reconnects from the same iframe skip replay to avoid duplicating visible terminal content. If the shell process itself exits, the runner closes connected sockets and the next fresh iframe connection starts a new PTY.

This persistence is scoped to the current Cloud Run container instance. A Cloud Run revision replacement, service stop, container crash, or scale-down still ends the PTY process.

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

The backend sets these when provisioning the Cloud Run session service.
`STORAGE_BUCKET` comes from the workspace record when present, then falls back to `SESSION_BUCKET`, then Firebase's configured default `storageBucket`.

The browser sidebar lists workspace files from Cloud Storage through the Cloud Functions API, not directly from a running session container. `GET /api/workspaces/{workspaceId}/files` validates workspace ownership and lists objects under the workspace `storagePrefix`, so the Files section reflects the latest synced objects even when no terminal iframe is selected. Running containers still control when local `/workspace` changes are uploaded; by default `session-runner/server.js` syncs up every 30 seconds.

Cloud Storage does not store real directories, so the runner uploads a `.mapahce-directory` marker object inside each synced directory. The Files API maps those marker objects to `type: "directory"` entries and filters them out of the displayed file list. Existing Cloud Run sessions need a new runner revision before empty directories can appear in the sidebar.

## Provisioning

When a session is created, `functions/index.js` stores the session record and provisions a Cloud Run service using the selected image. The image value comes from the create-session payload when present, or from the backend `SESSION_RUNNER_IMAGE` default.

Each session service is named with the session id:

```text
session-<lowercase-session-id>
```

Cloud Run resource limits are derived from the session's CPU and memory settings.

Stopping a running session from the sidebar calls the backend stop route for that session. The backend deletes the per-session Cloud Run service, which terminates the `session-runner` container, then updates the Firestore session record to `stopped` and clears `serviceUrl`. If the Cloud Run service is already gone, the session is still marked stopped.

## Existing Sessions vs New Sessions

Pushing a new `:latest` image affects new pulls, but existing Cloud Run services need a new revision to pick it up. For an existing session service, update the service image to create a fresh revision:

```bash
gcloud run services update SERVICE_NAME \
  --image us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:latest \
  --region us-central1 \
  --project pi-agents-cloud
```

New sessions use the image selected in the modal. Existing sessions keep their current image until the Cloud Run service is updated or the session is recreated.

## Design Decisions

- Browser terminals should use a real terminal emulator. The app uses xterm.js so terminal programs and shell formatting render correctly.
- The runner keeps the PTY alive across WebSocket disconnects so frontend re-renders, iframe reloads, and brief network drops do not discard in-progress terminal work.
- Runtime image selection is user-facing but config-controlled. This prevents arbitrary image entry in the UI while keeping the path open for curated images.
- Containers include common developer tools by default when they are broadly expected in terminal workflows.
- Image-specific startup should be controlled by environment variables in the image where possible. This keeps the runner server shared while allowing curated runtimes such as `pi-basic` to open a different PTY command.
- Existing sessions are not automatically recycled when the image config changes. This avoids surprising users by restarting active terminals.

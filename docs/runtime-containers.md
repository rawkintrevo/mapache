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

It starts an Express server on `PORT`, serves the terminal iframe page, and exposes a WebSocket at `/terminal`. On WebSocket connection, the server starts a process through `node-pty`.

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

## Provisioning

When a session is created, `functions/index.js` stores the session record and provisions a Cloud Run service using the selected image. The image value comes from the create-session payload when present, or from the backend `SESSION_RUNNER_IMAGE` default.

Each session service is named with the session id:

```text
session-<lowercase-session-id>
```

Cloud Run resource limits are derived from the session's CPU and memory settings.

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
- Runtime image selection is user-facing but config-controlled. This prevents arbitrary image entry in the UI while keeping the path open for curated images.
- Containers include common developer tools by default when they are broadly expected in terminal workflows.
- Image-specific startup should be controlled by environment variables in the image where possible. This keeps the runner server shared while allowing curated runtimes such as `pi-basic` to open a different PTY command.
- Existing sessions are not automatically recycled when the image config changes. This avoids surprising users by restarting active terminals.

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

The `codex-basic` runner image is built from `session-runner/Dockerfile.codex-basic` and published as:

```text
us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:codex-basic
```

The `codex-web` runner image is built from `session-runner/Dockerfile.codex-web` and published as:

```text
us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:codex-web
```

The frontend image dropdown is configured in `src/config/sessionImages.js`. It contains the default shell runner, `pi-basic`, `codex-basic`, `pi-web`, `codex-web`, and `pi-n64`, each with explicit capability metadata and a stable `imageKey`.

The backend is authoritative for image selection. `functions/runnerImages.helpers.js` contains the curated server-side image catalog. Session creation accepts `imageKey` and maps it to the catalog entry before provisioning Cloud Run. Legacy clients may still submit `image` only when it exactly matches a curated catalog image. Arbitrary user-supplied image URIs are rejected with `invalid_runner_image`.

## Base Environment

The image uses:

```dockerfile
FROM node:24-bookworm-slim
```

Installed OS packages currently include:

- `bash`
- `bubblewrap` in Codex images, so the Codex CLI can use its expected local sandbox path inside the already isolated runner
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

Codex images install the Codex CLI with the documented standalone installer in non-interactive mode:

```bash
CODEX_INSTALL_DIR=/usr/local/bin ./install-codex-standalone.sh
```

As of 2026-06-18, the Dockerfiles pin Codex CLI `0.140.0` and install the published Linux package tarball directly because that release's `codex-package_SHA256SUMS` file is missing the Linux standalone package entry and breaks the hosted `install.sh` flow.

## Runner Server Layout

The container entry point is still `session-runner/server.js`, but it is now a bootstrap/router layer rather than the full runtime implementation. Feature code lives under `session-runner/lib/`:

- `terminal.js` owns PTY lifecycle, WebSocket replay, and the terminal iframe HTML.
- `preview.js` owns preview gateway modes, including pi-web static/proxy previews, pi-n64 ROM artifact previews, and the browser log buffer.
- `workspace.js` composes workspace restore and sync behavior. Path filtering lives in `workspacePath.helpers.js`, archive target construction and tar upload/restore live in `workspaceArchives.service.js`, GitHub workspace reconstruction lives in `workspaceGithub.service.js`, and Pi auth/home materialization lives in `workspacePiAuth.service.js`.
- `git.js` composes runner Git behavior. Command execution, GitHub askpass auth, PR creation helpers, porcelain status parsing, and branch/path/payload validation live in focused `git*.js` modules beside it.
- `pi.js` composes runner Pi services while keeping the public server contract stable. Package operations live in `piPackage.service.js`, skill CRUD lives in `piSkill.service.js`, seeded skill file creation lives in `piSeededSkills.service.js`, default seeded skill Markdown lives under `session-runner/seeded-skills/`, and shared package/skill validation helpers live in `piValidation.helpers.js`.
- `activity.js`, `config.js`, `processes.js`, `services.js`, and `utils.js` hold shared runner plumbing.

Route paths, environment variables, storage paths, and startup order remain controlled by `server.js`.

All runner images copy `session-runner/seeded-skills/` into `/app/seeded-skills/` so file-backed Pi skill seeds are available at runtime. The seeding path treats these files as optional startup aids: if an expected seed file is absent, the runner logs a warning, skips that seed, and continues starting the session.

## Terminal Runtime

The container runs `session-runner/server.js`.

It starts an Express server on `PORT`, serves the terminal iframe page, and exposes a WebSocket at `/terminal`. The runner keeps one active `node-pty` process per container instance. Browser WebSocket connections attach to that PTY, and closing or recreating the browser iframe detaches only the socket instead of killing the process.

Browser access to the terminal page, `/terminal` WebSocket, `/preview/*`, `/healthz`, and `/capabilities` is gated by short-lived HMAC tokens minted by the authenticated Cloud Functions API. The runner receives a per-session `SESSION_BROWSER_TOKEN_SECRET` environment variable and validates the `mapache_access` query parameter or the HttpOnly `mapache_access` cookie before serving those browser surfaces. The query token is used for the initial iframe load; the cookie lets preview pages load relative assets and lets the terminal WebSocket reconnect without exposing the internal runner management token. Backend-only runner routes such as `/shutdown`, `/git/*`, `/pi/skills*`, and `/pi/packages*` continue to use the separate `SESSION_SHUTDOWN_TOKEN` header gate.

The runner stores a bounded raw-output replay buffer so a newly loaded iframe can redraw recent terminal output after reconnecting. The default replay limit is `1000000` characters and can be changed with `TERMINAL_REPLAY_LIMIT`. Automatic reconnects from the same iframe skip replay to avoid duplicating visible terminal content. If the shell process itself exits, the runner closes connected sockets and the next fresh iframe connection starts a new PTY.

This persistence is scoped to the current Cloud Run container instance. A Cloud Run revision replacement, service stop, container crash, or scale-down still ends the PTY process.

The runner reports terminal activity back to the session document in Firestore. WebSocket connects and disconnects update `activeSocketCount`, `lastConnectedAt`, `lastDisconnectedAt`, and `lastActivityAt`; terminal input updates `lastActivityAt` with a short debounce to avoid one Firestore write per keystroke.

For the default shell runner, that process is a login shell:

```text
bash -l
```

For Pi runners, that process is Pi resume mode:

```text
pi -c
```

Cloud Functions sets `TERMINAL_COMMAND` and JSON-array `TERMINAL_ARGS` when provisioning each session. The default shell runner receives `TERMINAL_COMMAND=bash` and `TERMINAL_ARGS=["-l"]`; `pi-basic`, `pi-web`, and `pi-n64` receive:

```text
TERMINAL_COMMAND=pi
TERMINAL_ARGS=["--session-dir","<per-session-pi-dir>","-c"]
```

Pi conversations are scoped to the Mapache session, not to the user or workspace. New Cloud sessions receive an empty per-session Pi session directory and start a fresh Pi JSONL conversation. The session document stores the session-specific Pi storage prefix and, after Pi creates it, the bound JSONL path. If the same Cloud session is opened from another tab/device or its Cloud Run instance restarts, the runner restores that per-session archive and resumes that Cloud session's Pi conversation. Mid-turn process, stream, or PTY state is not durable; restart resumes from the last completed Pi session entry.

Codex runners receive `TERMINAL_COMMAND=codex` and `TERMINAL_ARGS=[]`. Cloud Functions also sets `CODEX_HOME` to a per-session path such as `/tmp/mapache-codex/<session-id>`, plus a session-specific archive prefix. That keeps Codex auth, logs, sessions, skills, and standalone package metadata separate from repository `.codex/config.toml` files under `/workspace/.codex` and prevents one Mapache session's Codex state from leaking into another.

For connected GitHub workspaces, non-shell Pi sessions also prepare a clean automation branch before the terminal process starts. The runner fetches the selected base branch, resets the restored worktree to that remote branch, removes untracked non-ignored files, checks out a unique branch named `mapache/<session-name-kebab>-<session-id>`, and records that branch on the session document. When the Pi terminal process exits, the runner stages any remaining workspace changes and commits them with a Mapache-authored commit. If the automation branch already has commits and the worktree is clean, the runner pushes those commits without creating an extra commit. It then opens a pull request back to the base branch with the short-lived GitHub App installation token. If there are no changes and no commits ahead of the base branch, the runner records `githubAutomationStatus: "no_changes"` and does not create a commit or PR. Shell sessions and non-connected GitHub workspaces keep the manual Git controls behavior only.

The browser terminal uses `@xterm/xterm` instead of a plain text `<div>`. This is important because PTY output includes ANSI escape sequences, cursor movement, alternate screen buffers, colors, and TUI control codes. Rendering raw PTY output as text caused artifacts such as `[0m[2m-`.

The terminal page also loads `@xterm/addon-fit` from the runner and fits the xterm viewport to the actual iframe dimensions before sending resize events to the PTY. Avoid returning to hand-estimated character cell sizes; Codex's TUI depends on the browser terminal and PTY agreeing on rows and columns so typed input and long model output stay visible.

## Pi Basic Runtime

`session-runner/Dockerfile.pi-basic` starts from the same Pi-oriented base image and package set as the default runner.

The image sets `TERMINAL_COMMAND=pi` and `TERMINAL_ARGS=["-c"]`, so new browser terminal connections open Pi in resume mode instead of a login shell or fresh conversation.

The skills manager targets `pi-basic` first. Skill listing and mutations require a running session so the manager can write the same `/workspace/.pi/skills/{skill-name}/SKILL.md` files that Pi discovers at startup.

For blank workspaces, `pi-basic` does not seed GitHub workflow skills. For GitHub-backed workspaces, it seeds `mapache-github-issue` when the workspace-local copy is missing.

The extension manager targets Pi-capable runners. For v1, package listing and package mutations can require a running session so the manager can operate on the same `/workspace/.pi/settings.json` and package cache directories that Pi uses.

Build and push the image with:

```bash
gcloud builds submit session-runner \
  --project pi-agents-cloud \
  --config session-runner/cloudbuild.pi-basic.yaml
```

## Codex Basic Runtime

`session-runner/Dockerfile.codex-basic` is the terminal-first Codex runner. It installs the standalone Codex CLI and starts the browser terminal in interactive `codex` mode.

For blank workspaces, `codex-basic` seeds a root `AGENTS.md` when it is missing. For connected GitHub workspaces, it seeds `.agents/skills/mapache-github-issue/SKILL.md` when that file is missing. These Codex-specific workspace seeds are separate from Pi `.pi` files and never overwrite user-edited workspace files.

Codex startup also imports existing workspace-local Pi skills from `.pi/skills/**` into `.agents/skills/{skill-name}/SKILL.md` when the Codex copy is missing. The import normalizes every copied skill to Codex-compatible YAML frontmatter with `name` and `description`, including legacy Pi skill files that lack frontmatter, and does not overwrite user-edited Codex skills.

Build and push the image with:

```bash
gcloud builds submit session-runner \
  --project pi-agents-cloud \
  --config session-runner/cloudbuild.codex-basic.yaml
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
- `POST /preview/share` for backend-only static preview export to Cloud Storage. This route requires the runner shutdown token and is not available through browser preview access.

The `pi-web` static preview serves generated output from `/workspace/build`. The seeded `mapache-preview-build` skill instructs agents to emit browser-loadable output there and to configure relative asset bases, such as Vite's `base: "./"`, so bundled assets resolve correctly under `/preview/`.

Share Preview uses the same static preview root. The runner reads the active preview config, accepts only static mode, requires `/workspace/build/index.html` or the configured static root's `index.html`, skips symlinks, and uploads regular files under that root to the storage prefix supplied by the authenticated API. The V1 export is bounded to 1000 files and 100 MiB. It does not export proxy-mode upstream responses, the full workspace, hidden session state, auth material, environment variables, or archive-backed internal directories outside the static root.

Public shared previews are served by the Cloud Functions API from `publicPreviews/{token}` metadata and Cloud Storage objects. Preview tokens are unguessable and expire after 30 days; expired previews return HTTP 410. There is not yet a dedicated garbage-collection job for expired preview objects, so storage cleanup is a maintenance follow-up if preview volume grows.

HTML responses from the static preview receive a small development logger script when `PREVIEW_INJECT_LOGGER=true`. It forwards `console.log`, `console.info`, `console.warn`, `console.error`, `window.onerror`, and unhandled promise rejections to the runner log buffer. QA agents can combine these logs with Playwright screenshots and interaction checks without needing to scrape the terminal.

Agents can switch the preview gateway from static-file serving to a local app/API server by writing `/workspace/.mapache/preview.json`:

```json
{
  "mode": "proxy",
  "upstream": "http://127.0.0.1:3000"
}
```

Only localhost upstreams are accepted. In proxy mode, `/preview/*` forwards HTTP methods and paths to the upstream server, so a framework dev server, Express app, or function emulator can serve both browser routes and API routes through the same Preview canvas. Removing the file, or setting `mode` to `static`, returns the preview to static serving from `/workspace/build` or a valid `staticRoot` in `/workspace/.mapache/preview.json`.

On startup, GitHub-backed Pi workspaces seed `mapache-github-issue`, a workflow skill for taking a GitHub issue number, reading issue context and comments through the GitHub API, confirming the base branch is up to date before editing, asking clarifying or decision questions when needed, implementing the scoped change, and ending with a local commit. Blank workspaces do not seed this GitHub-specific skill. The default seeded skill payloads are versioned as normal `SKILL.md` files under `session-runner/seeded-skills/{skill-name}/SKILL.md`; the runner copies them into `/workspace/.pi/skills/{skill-name}/SKILL.md` only when a workspace-local file is missing.

On startup, `pi-web` also seeds three workspace-local Pi skills when they are missing:

- `mapache-preview-build`
- `mapache-api-hosting`
- `mapache-preview-qa`

These files are written under `/workspace/.pi/skills/{skill-name}/SKILL.md` after workspace restore and before the Pi terminal process starts, so Pi can discover them in new `pi-web` sessions. Existing user-edited skills with the same names are not overwritten.

Build and push the image with:

```bash
gcloud builds submit session-runner \
  --project pi-agents-cloud \
  --config session-runner/cloudbuild.pi-web.yaml
```

## Codex Web Runtime

`session-runner/Dockerfile.codex-web` is the web-development Codex runner. It has the same Chromium, Playwright, preview gateway, browser log capture, and capabilities contract as `pi-web`:

```json
{"terminal":true,"preview":true,"previewQa":true,"functions":true}
```

It seeds Codex-native workspace files instead of Pi `.pi` skills. When the target file is missing, startup writes:

- `.agents/skills/mapache-preview-build/SKILL.md`
- `.agents/skills/mapache-api-hosting/SKILL.md`
- `.agents/skills/mapache-preview-qa/SKILL.md`
- `.agents/skills/mapache-github-issue/SKILL.md` for connected GitHub workspaces

As with `codex-basic`, startup imports missing Codex copies of workspace-local Pi skills from `.pi/skills/**` and normalizes frontmatter so Codex accepts the skills on load.

Build and push the image with:

```bash
gcloud builds submit session-runner \
  --project pi-agents-cloud \
  --config session-runner/cloudbuild.codex-web.yaml
```

## Pi N64 Runtime

`session-runner/Dockerfile.pi-n64` is the Nintendo 64 homebrew runner. It starts from the same Pi-oriented shape as `pi-basic`, then installs the libdragon prebuilt MIPS64 toolchain Debian package, builds libdragon from the `trunk` branch, and installs libdragon and its host tools into `/opt/libdragon`. The image build includes a smoke check that verifies `/opt/libdragon/include/n64.mk`, required libdragon host tools, and a minimal ROM compile through the same `include $(N64_INST)/include/n64.mk` path used by workspace projects. The seeded build skill documents the same Makefile shape: produce a root `.z64` target and then copy it to `/workspace/build/game.z64`, rather than making the primary libdragon target live under `build/`.

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
- `GET /preview/logs` reports browser console output, window errors, and unhandled rejections from the Mapache-owned emulator shell. The shell posts logs to a token-signed endpoint so log capture does not depend on third-party iframe cookies.

Agents can override the ROM path and emulator core by writing `/workspace/.mapache/preview.json`:

```json
{
  "mode": "n64",
  "rom": "build/custom.z64",
  "core": "mupen64plus_next"
}
```

Only `.z64`, `.n64`, and `.v64` files inside `/workspace` are accepted. The core can be `n64`, `mupen64plus_next`, or `parallel-n64`; the older `parallel_n64` spelling is accepted and normalized to EmulatorJS's documented `parallel-n64` core id. Invalid values fall back to `n64`, which uses EmulatorJS's default N64 core. The browser shell uses EmulatorJS from the stable CDN and keeps `/preview/rom.z64` as the stable ROM artifact URL for downloads and external emulator checks. When the shell is opened with a browser-access token, its ROM, status, and log links include the same signed token so EmulatorJS subresource fetches and browser log capture do not depend on third-party iframe cookies.

On startup, `pi-n64` also seeds two workspace-local Pi skills when they are missing:

- `mapache-n64-build`: explains how to build/package a homebrew ROM to `/workspace/build/game.z64`.
- `mapache-n64-preview`: explains the N64 browser emulator shell, status endpoint, ROM endpoint, and optional core override.

These files are written under `/workspace/.pi/skills/{skill-name}/SKILL.md` after workspace restore and before the Pi terminal process starts, so Pi can discover them in new `pi-n64` sessions. Existing user-edited skills with the same names are not overwritten.

Build and push the image with:

```bash
gcloud builds submit session-runner \
  --project pi-agents-cloud \
  --config session-runner/cloudbuild.pi-n64.yaml
```

## Workspace Sync

Each container uses `/workspace` as its working directory.

The runner can sync files from Cloud Storage before serving the terminal and periodically upload workspace contents back to Cloud Storage. The sync destination is controlled by environment variables:

- `STORAGE_BUCKET`
- `STORAGE_PREFIX`
- `HOME`
- `MAPACHE_HOME_DIR`
- `HOME_STORAGE_BUCKET`
- `HOME_STORAGE_PREFIX`
- `HOME_SYNC_MODE`
- `HOME_ARCHIVE_NAME`
- `PI_SESSION_DIR`
- `PI_SESSION_STORAGE_BUCKET`
- `PI_SESSION_STORAGE_PREFIX`
- `PI_SESSION_JSONL_PATH`
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

Workspace records also carry an app-owned `syncPolicy` field. Blank workspaces default to `mode: "blank"` with no exclusions. GitHub workspaces default to `mode: "github-cache"` and exclude `.git/`, `node_modules/`, build outputs, `.next/`, and `.mapache-internal/` paths from normal file sync.

The backend passes that policy into the runner with:

- `WORKSPACE_SYNC_POLICY_MODE`
- `WORKSPACE_SYNC_POLICY_EXCLUDE` (JSON array)

Normal upload/download sync now applies base exclusions for archive-backed/internal paths plus any `syncPolicy.exclude` entries. That keeps blank workspace behavior effectively unchanged while letting GitHub workspaces skip extra cached paths during ordinary file sync. Directory marker objects still apply for non-excluded directories.

Workspace records also carry an app-owned `homePolicy` field. New workspaces default to a persistent `$HOME` rooted at `/root`, archived under `{workspace.storagePrefix}/.mapache-internal/home/home.tar.gz`. The workspace owns this materialized home tree; sessions receive a resolved copy on creation and restore/archive that same tree through `HOME_STORAGE_BUCKET`, `HOME_STORAGE_PREFIX`, `HOME_SYNC_MODE`, and `HOME_ARCHIVE_NAME`. The archive is runtime state, not workspace content: Files API routes and sidebar listings hide `.mapache-internal/` objects.

As of 2026-06-19, new writes use canonical `.mapache-internal` and `.mapache-directory` names. The backend and runner still read the historical `.mapahce-internal` and `.mapahce-directory` paths so existing workspaces, archive objects, and empty-directory markers continue restoring correctly. Client file APIs, sync filters, and Git-path validation must treat both spellings as hidden internal/runtime state.

Workspace and session records may also carry non-secret env maps. During Cloud Run provisioning, the backend merges them as image defaults, then workspace env, then session env, then Mapache-reserved runtime env. Session env can override workspace env, but neither can set reserved variables such as `HOME`, `WORKSPACE_DIR`, `SESSION_ID`, storage prefixes, runner tokens, terminal command vars, or preview/system vars.

The browser sidebar lists workspace files from Cloud Storage through the Cloud Functions API, not directly from a running session container. `GET /api/workspaces/{workspaceId}/files` validates workspace ownership and lists objects under the workspace `storagePrefix`, so the Files section reflects the latest synced objects even when no terminal iframe is selected. Running containers still control when local `/workspace` changes are uploaded; by default `session-runner/server.js` syncs regular workspace files every 30 seconds.

The sidebar upload action writes to that same Cloud Storage prefix. Small uploads use Cloud Functions with `POST /api/workspaces/{workspaceId}/file?path={filename}`. Files above the Function body limit use Firebase Storage resumable upload directly from the browser, guarded by Storage Rules under the workspace owner's `/workspaces/{uid}/...` tree. The sidebar download action asks Cloud Functions for a short-lived signed URL for the selected object, then lets the browser download from that URL so binary artifacts do not need to pass through Cloud Functions response bodies, Firebase Storage JavaScript body reads, or the text editor path. This makes browser-uploaded files immediately visible to future sessions and to the Files listing after refresh. During periodic sync-up, the runner compares local file mtimes with Cloud Storage `updated` timestamps; if the Storage object is newer, the runner downloads it into `/workspace` instead of overwriting it. That lets edits made through the sidebar, including `.mapache/preview.json`, converge into a running container while local files created inside a terminal still flow in the opposite direction.

This behavior now needs to be read together with workspace source mode:

- For `blank` workspaces, Cloud Storage remains the durable source of truth.
- For `github` workspaces, Cloud Storage is a cache and resumability layer for the last active local state. GitHub is the durable repository source of truth.

Cloud Storage does not store real directories, so the runner uploads a `.mapache-directory` marker object inside each synced directory. The Files API maps those marker objects to `type: "directory"` entries and filters them out of the displayed file list. The runtime still recognizes the legacy `.mapahce-directory` marker while old objects remain in storage. Existing Cloud Run sessions need a new runner revision before empty directories can appear in the sidebar.

High-cardinality runtime directories are not synced as individual Cloud Storage objects:

- `/workspace/node_modules`
- `/workspace/.git` for GitHub-backed workspaces
- `$HOME`

The Pi extension manager extends this model to workspace-local Pi package cache directories:

- `/workspace/.pi/npm` archived as `.mapache-internal/archives/workspace-pi-npm.tar.gz`
- `/workspace/.pi/git` archived as `.mapache-internal/archives/workspace-pi-git.tar.gz`

The portable package declaration file, `/workspace/.pi/settings.json`, remains normal workspace file state. Package install directories are runtime cache state and are archived under `.mapache-internal/archives/` instead of uploaded object-by-object. Normal workspace sync skips `.pi/npm/` and `.pi/git/`, while the Files API and editor routes hide those cache paths and the internal archive objects.

The runner restores these directories from gzip-compressed tar archives during startup and uploads them as single archive objects on the slower archive sync interval. It also forces an archive upload during the protected shutdown sync before a session service is deleted.

`/workspace/node_modules` and `/workspace/.git` remain workspace-scoped. Their archives live under `.mapache-internal/archives/` inside the workspace storage prefix, and the Files API hides that internal directory from the sidebar and editor routes.

The `$HOME` archive includes Pi auth, settings, package caches, shell state, and per-session Pi conversation directories. Treat the archive path as sensitive runtime state because it can contain credentials and command history. It lives under the hidden workspace internal prefix, and client file APIs must not expose it.

Each Cloud session uses a unique Pi conversation directory under `$HOME/.pi/agent/mapache-sessions/{sessionId}`. The runner launches Pi with `--session-dir $PI_SESSION_DIR -c` and updates the session document with `piSessionJsonlPath`/`piSessionJsonlRelativePath` after Pi creates the JSONL. The whole-home archive persists those directories, but the session id keeps each Cloud session's thread separate from other sessions in the same workspace.

Pi provider auth is also mirrored in Firestore at `users/{uid}/private/piAuth`. The legacy `providers` map still matches Pi's `$HOME/.pi/agent/auth.json` object shape exactly (`providerKey -> credential object`) for compatibility, while the `entries` map stores named credentials as `entryId -> {providerKey, label, credential}` so users can keep multiple credentials for one Pi provider and choose which one a session should use. The backend API writes web-added API keys as `{type: "api_key", key: "..."}` and records them as named entries. It also supports OpenAI ChatGPT Plus/Pro Codex subscription login through OpenAI's device-code flow and saves completed OAuth credentials for `openai-codex` as `{type: "oauth", access, refresh, expires, accountId}` entries. Pi sessions may store `piAuthSelection` (`providerKey -> entryId`) on the session document. The runner receives `OWNER_UID`, reads any restored/local `auth.json` entries from `$HOME/.pi/agent/auth.json` into Firestore, and materializes either the selected entries or all legacy providers back into that same file with `0600` permissions on startup and during periodic sync. The backend sets `PI_CODING_AGENT_DIR=$HOME/.pi/agent` so Pi resolves auth storage to the materialized home tree. This makes CLI/TUI `/login` additions visible to the web UI after runner sync while letting web-added credentials appear in already-running sessions after the runner sync interval; an active Pi process may still need `/reload` to pick up rewritten credentials.

For GitHub workspaces, treating `/workspace/.git` as archive-backed state is also a consistency boundary. The app should not expose Git internals through normal file listing or per-file object sync. Restoring `.git` from a single archive is safer than trying to mirror Git internals as ordinary Cloud Storage objects. Normal sync now skips `.git` paths for GitHub workspaces, and archive upload stores `.git` under the hidden internal archive prefix while skipping obvious transient `*.lock` files where practical. Dedicated startup restore ordering for `.git` remains a later task.

This keeps dependency installs, Git metadata, and Pi Agent state available without creating thousands of Cloud Storage objects for `node_modules` or `.git`. Archive-backed changes can lag normal file sync by up to `ARCHIVE_SYNC_INTERVAL_MS` unless the session is stopped cleanly, which triggers the final archive sync.

The detailed GitHub workspace architecture, including one-active-session enforcement and cache semantics, lives in [github-workspaces.md](./github-workspaces.md).

The Pi extension manager architecture, including workspace-local package scope, package catalog metadata, write locations, and active-session behavior, lives in [pi-extension-manager.md](./pi-extension-manager.md).

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

When a session is created, `functions/index.js` stores the session record and provisions a Cloud Run service using the selected curated image. The Cloud Run API request construction, patch/delete flows, service-account resolution, resource limit mapping, and runner environment variable construction live in `functions/cloudRun.service.js`; GitHub source metadata, short-lived installation-token env vars, connected repository normalization, and pull request API calls live in `functions/github.service.js`; Pi auth storage, OpenAI Codex subscription login, package catalog/proxy behavior, skill proxy behavior, and Pi payload validation live in `functions/pi.service.js`; session ownership and Firestore state transitions remain outside those modules. The create-session payload should include `imageKey`; the backend resolves that key through `functions/runnerImages.helpers.js` and stores `imageKey`, the resolved `image` URI, and `terminalKind` on the session. If no image key is present, the backend uses the operator-controlled `SESSION_RUNNER_IMAGE` default. Direct user-provided image URIs are not accepted unless they exactly match a curated catalog image for legacy client compatibility.

GitHub workspaces still enforce one active Pi/agent session at a time so two agents cannot race on cached Git state. Shell-kind sessions are allowed alongside an active Pi session because they do not attach to the same Pi conversation state. They still share the workspace files and Git checkout, so user edits from the shell can race with agent edits at the normal filesystem and sync layers.

Each session service is named with the session id:

```text
session-<lowercase-session-id>
```

Cloud Run resource limits are derived from the session's CPU and memory settings.

Each session service must run as the dedicated runner service account configured by the Cloud Functions parameter/environment value `SESSION_RUNNER_SERVICE_ACCOUNT`. In production this is `mapache-runner@pi-agents-cloud.iam.gserviceaccount.com`. The backend sets Cloud Run `template.serviceAccount` on create, resize, and restart. If that value is missing, session provisioning fails closed instead of allowing Cloud Run to fall back to the project's default Compute Engine service account. Existing session records may also carry the resolved `serviceAccount` value, which the backend can use as a fallback when recreating an older stopped session.

The runner service account should have only the runtime data permissions it needs, currently Firestore user access and object admin access to the configured workspace bucket. The Functions service account should be separate, configured with `FUNCTION_SERVICE_ACCOUNT`, and granted Cloud Run administration plus `roles/iam.serviceAccountUser` only on the runner service account. Do not grant `roles/editor` to the default Compute Engine service account for this flow.

The `roles/iam.serviceAccountUser` binding is required for the production API identity to set Cloud Run `template.serviceAccount`. If new session provisioning fails with `Permission 'iam.serviceaccounts.actAs' denied`, restore this binding:

```bash
gcloud iam service-accounts add-iam-policy-binding \
  mapache-runner@pi-agents-cloud.iam.gserviceaccount.com \
  --project pi-agents-cloud \
  --member serviceAccount:mapache-api@pi-agents-cloud.iam.gserviceaccount.com \
  --role roles/iam.serviceAccountUser
```

The service identities involved in provisioning also need pull access to the Artifact Registry repository that stores the curated runner images. Without `roles/artifactregistry.reader`, session provisioning can fail while creating a revision with `artifactregistry.repositories.downloadArtifacts` denied, even when the image tag exists. Grant it at repository scope to the Functions service account that creates Cloud Run services, the runner service account assigned to session revisions, and the Cloud Run service agent:

```bash
PROJECT_NUMBER="$(gcloud projects describe pi-agents-cloud --format='value(projectNumber)')"
gcloud artifacts repositories add-iam-policy-binding pi-agents \
  --location us-central1 \
  --project pi-agents-cloud \
  --member "serviceAccount:mapache-api@pi-agents-cloud.iam.gserviceaccount.com" \
  --role roles/artifactregistry.reader
gcloud artifacts repositories add-iam-policy-binding pi-agents \
  --location us-central1 \
  --project pi-agents-cloud \
  --member "serviceAccount:mapache-runner@pi-agents-cloud.iam.gserviceaccount.com" \
  --role roles/artifactregistry.reader
gcloud artifacts repositories add-iam-policy-binding pi-agents \
  --location us-central1 \
  --project pi-agents-cloud \
  --member "serviceAccount:service-${PROJECT_NUMBER}@serverless-robot-prod.iam.gserviceaccount.com" \
  --role roles/artifactregistry.reader
```

Stopping a running session from the sidebar calls the backend stop route for that session. The backend deletes the per-session Cloud Run service, which terminates the `session-runner` container, then updates the Firestore session record to `stopped` and clears `serviceUrl`. If the Cloud Run service is already gone, the session is still marked stopped. Restarting a stopped session recreates the per-session Cloud Run service from the stored session and workspace metadata instead of patching the deleted service. The same recreate path is used for older records left in `update_failed` after a restart tried to patch a Cloud Run service that no longer exists. Deleting a session from the sidebar uses the same service deletion path for any still-running service, then removes the session document from Firestore so it no longer appears in the workspace session list. Deleting a workspace runs that same Cloud Run cleanup for every child session before removing the workspace document tree and Cloud Storage objects under the workspace prefix when no other workspace references that prefix.

Before deleting a service, the backend calls the runner's protected `POST /shutdown` endpoint when the session has a `serviceUrl` and `shutdownToken`. The runner performs one final workspace sync, including archive-backed directories, and records `shutdownRequestedAt`; the backend still proceeds with deletion if this best-effort request fails. Older sessions without a shutdown token skip this step.

When a session reaches the stopped path, the backend records an allocated usage interval under `users/{uid}/sessionUsage/{sessionId}` and marks the session with `usageAccountedAt`. The interval uses the session's active runtime multiplied by the configured Cloud Run CPU and memory limits, producing CPU seconds and memory GiB-seconds for the profile page. Resize operations accrue usage through the resize timestamp before changing the session's resource limits, so lifetime totals account for resource changes within a session. Restarting a stopped session accrues the previously stopped interval, clears `usageAccountedAt`, and starts a new active interval so the next stop records cumulative active usage without charging for time spent stopped. Running sessions and older stopped sessions without `usageAccountedAt` are still included dynamically by `/api/me`, so the profile can show lifetime and trailing-30-day usage without enforcing quotas. These counters intentionally do not use Cloud Monitoring utilization or billing-export data.

Usage reads depend on collection group indexes in `firestore.indexes.json`. The profile API queries `workspaces/{workspaceId}/sessions` by `ownerUid` to include running and unaccounted sessions, and admin-wide reporting can query `users/{uid}/sessionUsage` by `ownerUid` or `endedAt` to aggregate across users and trailing windows.

The runner also exposes protected Git endpoints that use the same token gate. `GET /git/status` derives branch, commit, ahead/behind, dirty counts, conflicted state, and changed file entries from Git commands inside `/workspace`. `POST /git/pull` runs a fixed fetch/pull flow for GitHub workspaces and returns updated Git state afterward. `POST /git/stage` and `POST /git/unstage` accept validated workspace-relative paths only, so the backend/UI can stage or unstage changed files without exposing arbitrary command execution. `POST /git/commit` accepts a validated commit message, rejects empty commits, and returns updated Git state plus the committed head SHA. `POST /git/push` pushes the current branch only; it does not stage or commit dirty worktree changes first. It uses a short-lived installation token supplied in the protected request body for connected GitHub App repositories, falling back to runner credentials from `GITHUB_PUSH_TOKEN` and optional `GITHUB_PUSH_USERNAME` for public URL workspaces or explicitly configured services. If Cloud Run rejects a protected runner call before it reaches the app, such as a `429` no-instance response, the backend surfaces `runner_busy_or_unavailable` so the frontend can distinguish runner capacity from Git errors. If no usable credentials are available, the endpoint returns a clear auth-not-configured error instead of logging secrets. For blank workspaces these endpoints return a structured non-Git response instead of pretending Cloud Storage state is a repository.

The skill endpoints follow the same protected-runner pattern. Cloud Functions verifies workspace/session ownership, then proxies skill list/save/delete requests to the runner with its protected token. The runner serializes skill file mutations, writes Markdown under `/workspace/.pi/skills`, and runs normal workspace sync afterward.

Package endpoints follow the same protected-runner pattern. Cloud Functions verifies workspace/session ownership, then proxies package list/install/remove/update requests to the runner with its protected token. The runner serializes package operations and operates on workspace-local Pi settings by default.

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

The same rule applies to the dedicated runner service account, new GitHub workspace source env vars, sync-policy env vars, home materialization env vars, workspace/session env vars, Pi skill endpoints, Pi package manager endpoints, Pi package archive targets, preview environment changes, and terminal defaults. Existing Cloud Run services do not automatically gain `template.serviceAccount`, `WORKSPACE_SOURCE_TYPE`, `GITHUB_*`, `WORKSPACE_SYNC_POLICY_*`, `HOME_STORAGE_*`, `/pi/skills*`, `/pi/packages*` runner routes, `.pi/npm`/`.pi/git` archive behavior, or the `pi -c` resume default; they need a new revision or a recreated session service before runner changes that depend on those variables, routes, identities, image `ENV` values, or session fields will take effect.

When `functions/` changes are part of the package manager work, deploy Cloud Functions before handoff unless explicitly skipped:

```bash
firebase deploy --only functions --project pi-agents-cloud
```

Expected package-manager write locations:

- Workspace package declarations: `{workspace.storagePrefix}/.pi/settings.json`
- Workspace package cache archives: `{workspace.storagePrefix}/.mapache-internal/archives/workspace-pi-npm.tar.gz` and `workspace-pi-git.tar.gz`
- Workspace-owned home archive: `{workspace.storagePrefix}/.mapache-internal/home/home.tar.gz`
- User package catalog: `users/{uid}/piPackageCatalog/{encodedPackageIdentity}`

## Design Decisions

- Browser terminals should use a real terminal emulator. The app uses xterm.js so terminal programs and shell formatting render correctly.
- The runner keeps the PTY alive across WebSocket disconnects so frontend re-renders, iframe reloads, and brief network drops do not discard in-progress terminal work.
- Idle shutdown is controlled by Cloud Functions instead of browser timers so abandoned sessions are cleaned up even after the browser is closed.
- Runtime image selection is user-facing but backend-enforced. The UI exposes curated image keys, and Cloud Functions rejects arbitrary image URIs from normal session creation. Bring-your-own-image support, if added later, should be a separate permission-gated untrusted-workload path rather than an extension of the normal image selector.
- Containers include common developer tools by default when they are broadly expected in terminal workflows.
- Image-specific startup should be controlled by environment variables in the image where possible. This keeps the runner server shared while allowing curated runtimes such as `pi-basic` to open a different PTY command.
- Large generated runtime directories should use archive-backed sync instead of object-per-file Cloud Storage sync. This avoids slow file listings and excessive object counts for directories such as `node_modules`.
- Pi auth/settings may be user-scoped, but Pi conversation JSONLs must be session-scoped. New app sessions start with a fresh Pi conversation; the same app session can resume that conversation from its own archive.
- GitHub workspaces should archive `/workspace/.git` instead of exposing it through normal file sync. That keeps Git state resumable without treating Cloud Storage as a Git database.
- Workspace-local Pi skills should remain ordinary workspace Markdown files under `/workspace/.pi/skills`.
- Workspace-local Pi package install directories should use archive-backed sync while `/workspace/.pi/settings.json` remains normal workspace configuration.
- GitHub workspaces should allow only one active session at a time until the app has an explicit multi-session Git isolation model.
- Existing sessions are not automatically recycled when the image config changes. This avoids surprising users by restarting active terminals.

## Related Docs

- [Session runner architecture](./session-runner-architecture.md)
- [Backend API architecture](./backend-api-architecture.md)
- [GitHub workspaces](./github-workspaces.md)
- [Pi skills manager](./pi-skills-manager.md)
- [Pi extension manager](./pi-extension-manager.md)
- [Deployment](./deployment.md)

# Runtime Containers

Runtime containers are the Cloud Run services that back browser terminal sessions.

Runner control-plane Storage and Firestore clients always authenticate with the Cloud Run
metadata identity (`mapache-runner@pi-agents-cloud.iam.gserviceaccount.com`). Workspace-provided
`GOOGLE_APPLICATION_CREDENTIALS` remains available to terminal processes but must not override
the runner's own identity, because credentials stored under `/workspace` are unavailable until
after the control plane restores that workspace.

Live resource metrics support both unified cgroup v2 files and Cloud Run's cgroup v1 layouts.
The sampler handles the separately scoped `cpu` and `cpuacct` mounts used by Cloud Run Services,
the combined `cpu,cpuacct` mount used by Cloud Run Jobs, and the `memory` controller in both.

## Shared workspace buckets

Prepared shared-mode workspaces use one private Cloud Storage bucket in `us-central1`.
The Functions control plane derives the bucket name as
`mpw-<project-number>-<first-24-hex-sha256(workspaceId)>`, persists that exact identity
on the workspace, and never accepts a browser-provided bucket name. Creation is
idempotent and reconciles the existing bucket before applying the existing
`mapache-runner@pi-agents-cloud.iam.gserviceaccount.com` object binding.

The bucket contract is fixed at creation: Standard storage class, hierarchical
namespace enabled, uniform bucket-level access, public access prevention enforced,
Object Versioning disabled, and an explicit 604800-second (seven-day) Cloud Storage
soft-delete policy. A bucket with a different project, owner labels, region, HNS
setting, retention policy, public-access setting, or versioning setting is rejected;
the control plane does not silently adopt a foreign or incompatible bucket. Firestore
stores only normalized lifecycle state (`legacy`, `preparing`, `migrating`, `ready`,
or `error`) and normalized error codes to callers; the bucket identity remains private.

Preparation is explicit and requires the workspace to be paused, so a disabled
automation definition does not allocate storage by itself. `POST
/api/workspaces/{workspaceId}/automation-storage/prepare` acquires an idempotent
migration reservation and returns `202` while the scoped maintenance importer
uploads and verifies a fresh generation. The shared bucket is not mounted by
preparation: later migration publishes a verified
`trees/{storageGeneration}/` prefix before a runner receives it as `/workspace`.
When that trusted bucket/generation descriptor is present, Cloud Run provisioning
uses the shared template helper to add a gen2 `gcsfuse.run.googleapis.com` CSI
volume at `/workspace`. The mount is writable but scoped to the exact tree
generation and disables the GCS FUSE metadata/type caches, file/negative caches,
and noisy logging; legacy sessions without the descriptor keep their existing
template. The descriptor is backend-owned, so session/client bucket fields and
private archive storage cannot select the mounted bucket.
The runner receives the trusted generation as `WORKSPACE_STORAGE_GENERATION` and
uses `WORKSPACE_STORAGE_MODE=shared-gcsfuse-v1` only for a ready descriptor. Before
agent or shell startup it verifies the mounted generation-ready marker, verifies
that `/workspace` is writable, and rejects private runtime, Git, browser, and
agent-state paths that resolve into the mount. A shared mount is authoritative:
startup does not clone or restore a worktree, and periodic/final sync does not
upload, delete, or restore legacy worktree and Git archives. Private transcript,
Chrome, auth, and runtime cache/checkpoint roots remain outside the mount. The
legacy runner path is unchanged when no trusted descriptor is present.
The maintenance importer in `session-runner/maintenance/shared-workspace-import.js`
validates a local published workspace staging root before touching Cloud Storage. It
uploads files, supported relative symlinks, empty-directory markers, and original
mode metadata under a fresh `trees/{operationId}/` prefix using create-only
generation preconditions. Private `.git` metadata is archived separately as the
immutable shared-workspace Git seed; it is never written below the mounted tree.
The resumable control manifest lives under `.mapache-internal/shared-workspace-imports/`
outside the tree, records object generations and hashes, and is updated after each
object. Destination hashes are revalidated on resume, foreign changes fail closed,
and the generation-ready marker is published last. A caller must perform the
Firestore descriptor/pointer cutover; an interrupted unpublished generation can be
cleaned only through its owned control manifest.
Normal run completion never deletes a workspace bucket. Workspace deletion is
owned by the Functions-side `workspaceDeletionOperations/{workspaceId}`
operation: it tombstones the workspace first, fences checkpoint publication
and late automation admission, confirms every main and automation service is
absent, removes the runner IAM member, then deletes live objects and the
bucket. The operation removes published and unpublished tree generations,
private run artifacts, and automation records while preserving the user's
allocated usage ledger. It reports the seven-day `recoverableUntil` window and
known retained live bytes when available; soft-deleted objects remain
recoverable and can continue to incur storage charges until retention expires.

Admitted automation runs use the same trusted mount and pinned `pi-chrome` image
as other supported sessions, but receive a separate `auto-{runId}` session and
`mpauto-{runId-hash}` Cloud Run service. The service carries hashed owner,
workspace, and run labels; an existing service is adopted only when all labels
match the current run. Automation provisioning resolves connector credentials
at launch and keeps prompts and tokens out of service metadata and logs. The
run/session workers are idempotent across duplicate Firestore deliveries and
Cloud Run response loss; provisioning failure leaves cleanup responsible for
confirming service absence and releasing the run reservation.

## Runner Images

The supported runner image is built from `session-runner/Dockerfile.pi-chrome`
and published as:

```text
us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-chrome
```

Release automation also publishes immutable `pi-chrome-<source-commit>` tags.
Retired image tags and existing Cloud Run services are historical data; this
cutover does not purge them or make them selectable for new sessions.

Chrome desktop bootstrap waits for Xvfb to accept a real X client connection before launching
x11vnc or Chromium. x11vnc starts first after that readiness gate, so the loopback VNC listener
is not delayed by Chromium profile startup. The runner still requires the supervised desktop
processes, loopback VNC, and CDP to be ready before it opens the session HTTP port. Changes to
this bootstrap path require a rebuilt `pi-chrome` revision; existing Cloud Run services retain
their bundled startup behavior until restarted or recreated.

The `pi-chrome` build also packages the pinned pi-web-ui runtime under
`/opt/mapache/pi-web-ui`. `session-runner/upstream/pi-web-ui/build.mjs` fetches
commit `46880b3772591beac91c0c1792bdc79a6fe3671f` (package `0.79.0`), verifies
the source archive and package/license hashes, applies the checked-in patch
series, runs the upstream typecheck/tests/build, and copies only generated
runtime files plus `build-info.json` into the image. The build pins Pi SDK
`0.84.4` and `pi-mcp-adapter` `2.32.1`; it does not download or install anything
at runner startup. The generated health descriptor is safe for runtime status
reporting. Existing Cloud Run sessions do not contain this artifact until they
receive a new `pi-chrome` revision; see the [pi-web-ui integration checklist](./plans/pi-web-ui-tasks/README.md)
for the revision rollout.

The pinned patch series also contains `server/automation-run-state.ts`, a pure
reducer for one unattended automation run. It scopes events to the run and
conversation, deduplicates event and task IDs, requires a final non-retry agent
result plus drained tool/subagent/background work, and distinguishes
`interaction_required`, failure, cancellation, and success. It never infers
completion from log silence or aggregate turn counters and does not create
sockets, sessions, or API clients; the later automation subscription layer
owns event delivery. Changes to this reducer require the same upstream build
and a rebuilt `pi-chrome` revision.

The runner's automation execution service starts only after private workspace
materialization and runtime admission. It validates the owner/workspace/session
assignment, claims `executionStartedAt` before sending the prompt once over the
mode-0600 control socket, and polls the private reducer state with bounded
requests. Browser disconnects do not affect this loop. A ready-child loss marks
the run `interrupted` and leaves cleanup pending; the next boot never resumes a
previous prompt. Active automation is exempt from idle reaping only while its
admitted run assignment remains valid.

The managed-only presentation patch removes the upstream name/logo, version
controls, and repository link from the embedded header. It adds Chrome beside
the upstream Chat, Terminal, and Git tabs; that control emits the typed
`mapache.agent.navigate` bridge message so the exact-origin parent iframe host
can select the existing persistent Chrome canvas. The standalone upstream UI
keeps its original branding, release controls, and repository link.

The managed pi-web-ui build is compiled with `PI_WEB_BASE_PATH=/agent/`. The
browser therefore keeps every public asset and application endpoint under the
embedded prefix while the supervised upstream process continues to listen on
its internal root at port 8787. Tasks 4–6 own the child process and gateway
that translate these public paths:

| Public path | Internal pi-web-ui path | Owner |
| --- | --- | --- |
| `/agent/` and `/agent/assets/*` | `/` and `/assets/*` | HTTP gateway |
| `/agent/api/*` | `/api/*` | HTTP gateway |
| `/agent/themes/*`, `/agent/plugins/*`, `/agent/icons/*`, `/agent/manifest.webmanifest` | matching root-relative upstream path | HTTP gateway |
| `/agent/ws` | `/ws` | WebSocket gateway |

The only source-level root-relative exception is the favicon, which is patched
to `./favicon.svg`; Vite emits the module and stylesheet assets with the
`/agent/` base. The existing `appUrl` helper adds the same prefix to API,
WebSocket, theme, plugin, file-preview, download, locale, and notification
URLs. The managed build does not register a service worker. On upgrade it
unregisters only the exact app-scope `/agent/` registration or a worker whose
script URL is `/agent/sw.js`, leaving any Mapache parent-scope worker alone.

The server-owned workspace marker `agentUiVersion: "pi-web-ui-v1"` is passed to
the runner as `MAPACHE_AGENT_UI_VERSION=pi-web-ui-v1`. A marked `pi-chrome`
runner restores the published checkpoint after source/archive preparation and
before writer admission, credential materialization, and harness startup. It
then starts exactly one supervised child from
`/opt/mapache/pi-web-ui/dist/server/index.js`.
The child is fixed to loopback `127.0.0.1:8787`, runs with `/workspace` as its
fixed upstream cwd, uses `/var/lib/mapache/agent/pi` for non-secret Pi
configuration, `/var/lib/mapache/agent/sessions` as the explicit flat
`PI_CODING_AGENT_SESSION_DIR`, and `/var/lib/mapache/agent/ui` for UI state.
The upstream project picker and history actions follow existing symlinks and
reject paths outside those canonical roots; stale client workspace state is
ignored when it resolves outside `/workspace`. This constrains browser controls
without claiming a shell sandbox: the ordinary shell/PTY process still shares
the runner workspace. All browser clients list and open the same workspace
transcripts, including their SDK-preserved IDs and branches. The runner creates
a private per-boot token, uses it only for the local `/api/health` check, and
never includes it in status or logs. Startup is bounded by local health; a
startup failure or unexpected child exit is reported through runner activity
with no automatic respawn. Before materialization, the runner acquires a unique
boot instance ID for the reserved runtime generation in the workspace/session
coordination documents. Duplicate boots and stale generations remain fenced;
the runner renews that admission with bounded Firestore transactions and checks
it before state-changing agent requests and workspace publication. A lost or
indeterminate coordination read rejects new work and signals the detached
managed child process group, so physical container liveness is not treated as
writer admission. Shutdown sends a cooperative group signal and applies the
existing bounded stop/force-stop policy before final runner persistence, then
releases the boot ID only through the controlled lifecycle. If an
already-unavailable runner cannot acknowledge cooperative shutdown, Functions
deletes the Cloud Run service, clears the reserved authority through the normal
stopped transition, and records an interrupted-checkpoint warning. This is the
controlled recovery path for a fenced replacement boot; it does not permit
heartbeat-only authority takeover or concurrent writers.

For an automation runtime, the protected shutdown request first sends a
run-scoped cancellation through the private pi-web-ui control socket, then
awaits the same bounded agent quiesce and checkpoint/artifact finalization used
by ordinary runner shutdown. The Functions cleanup worker deletes only the
deterministic `mpauto-{runId-hash}` service after that request, confirms the
service is absent, and only then releases the automation slot. A timeout or
unclosed writer is retained as interrupted/partial persistence evidence.

The one-minute automation reconciler uses `/healthz` with the runner shutdown
credential for stale-heartbeat probes. It may reconcile setup polling or
cleanup, but it never restarts an automation prompt. Cloud Run orphan cleanup
is limited to services carrying the automation label set and rechecks those
labels immediately before deletion.

Managed agent persistence capture and restore live in
`session-runner/lib/agentSnapshot.service.js`,
`session-runner/lib/agentCheckpoint.service.js`, and
`session-runner/lib/agentCheckpointRestore.service.js`.
It stages the fixed `/var/lib/mapache/agent/sessions`, `/pi`, and `/ui` roots
under a private local directory, then writes a manifest with version, workspace /
session / generation / boot identity, capture time, relative paths, byte lengths,
SHA-256 checksums, and owner-safe permission bits. The storage namespace is
`{workspacePrefix}/{internalStorageDir}/agent-snapshots/v1`. Pi settings are allowlisted, known auth/connector material and
cache/process state are excluded using the auth inventory, and uploads are
copied only when complete history records reference them. JSON settings must
parse as an object or array and remain unchanged through acceptance. JSONL capture keeps complete
records and marks an incomplete trailing append for the next save. Relative
symlinks are retained without dereferencing when their resolved target remains
inside the same source root; absolute, escaping, dangling, or secret-targeting
links fail the capture rather than exposing an outside path. The staging
manifest is consumed by `session-runner/lib/agentCheckpoint.service.js`, which
uploads immutable objects below the versioned prefix and publishes a pointer only
after a generation/boot authority transaction succeeds. A failed or partial
upload leaves the previous pointer unchanged. Workspace files on the marked
runtime use the same publication boundary: each sync creates a versioned file
manifest with content hashes and tombstones, and the committed manifest—not a
delayed mutable upload or delete—is the authoritative file view. Unmarked
workspaces retain the legacy flat writer. Protected `/healthz` exposes only the
safe `lastCheckpointAt` timestamp and normalized `checkpointError` code. On the
next marked boot, `agentCheckpointRestore.service.js` reads only the published
pointer, validates the manifest identity, checksum, path, and JSON/JSONL content
in staging, and atomically installs the workspace and fixed agent roots with
rollback. Missing pointers leave a new runtime at image/default state; corrupt,
partial, unsafe, or mixed-generation data fails startup without replacing the
last local state. Marked workspace sync skips the legacy flat prefix and keeps
`.git` under its archive owner. Opening restored history is a storage/UI action
and does not submit a model request until the user explicitly prompts or resumes.

On the marked path, the runner starts one upstream pi-web-ui child and does not
start a legacy Pi TUI, Mapache Chat bridge, Goals RPC, or managed Goal package.
Historical unmarked sessions remain readable, but their parent UI no longer
exposes the retired Mapache Chat/Goals controls.

The marked runner's `/agent` HTTP gateway is owned by
`session-runner/lib/agentGateway.js`. It strips `/agent` before forwarding to
the loopback child, authenticates the signed agent audience and current
generation before any upstream request, and injects only the adapter's private
health token. Query credentials are removed by a no-referrer bootstrap
redirect, the access cookie is scoped to `/agent/`, upstream cookies and
off-origin redirects are discarded, and state-changing requests require the
runner's exact Origin. The gateway streams request/response bodies and Range
headers while enforcing the upstream 10 MiB JSON/body limit; `/agent/api/health`
is not a public authentication bypass. The central noServer upgrade dispatcher
maps `/agent/ws` to the child's `/ws` and authenticates the signed audience,
generation, expiry, and exact Origin before opening the child connection. It
forwards message payloads with bounded backpressure, strips public headers and
query credentials, injects the private token, closes both sides together, and
closes live pairs when access expires. Chrome VNC, terminal, shell, and metrics
upgrades remain separate dispatcher branches.

`PI_WEB_MANAGED=1` preserves Mapache's credential boundary while allowing
update checks, Pi installation requests, and plugin-catalog operations through
the authenticated upstream UI. The managed Settings UI exposes the same
UI-plugin catalog and add/install/update/remove controls as standalone
pi-web-ui. Credential-bearing model probes and
saves are still rejected; the server omits API keys and secret headers from
managed model-config responses while preserving existing server-side secrets
for metadata-only edits. The managed client replaces upstream credential entry
points with a Mapache-owned explanation, while model selection and non-secret
model metadata remain usable. The managed server forces `ENGINE=pi` even if a
stale `PI_WEB_ENGINE=dsh` value is present. Existing installed plugins and
ordinary agent settings remain available. The build and runtime environment
are still owned by the runner image and deployment pipeline. In particular,
the upstream `npm i -g pi-web-ui@latest` action does not replace the supervised
`/opt/mapache/pi-web-ui` artifact, and the embedded SDK is not the global Pi
binary. Durable, recoverable application/Pi self-update plus the requested Pi
package and custom web-theme controls remain open work in issue #356.
Workspace-local plugin/catalog and UI state are captured by the managed agent
snapshot. A rebuilt `pi-chrome` image and a new/recreated Cloud Run revision are
required for this patch-series change to reach existing sessions.

Managed auth is materialized from the canonical Mapache provider document into
`/var/lib/mapache/agent/pi/auth.json` after workspace restore and before the
supervised child starts. Restored `$HOME/.pi/agent/auth.json` is never imported
as managed input, and a stale `/var/lib/mapache/agent/pi/provider-keys.json` is
removed. `workspaceAuth.service.js` publishes a path-only, capture-excluded
inventory for native auth, provider keys, `models.json`, Pi MCP OAuth state,
GitHub CLI hosts, and the legacy restored auth path so the later capture helper
can exclude every known secret-bearing location.

Automation runners use the private storage mode instead of these legacy fixed
roots. Their HOME, auth, Pi sessions, UI data, sockets, Chrome profile, QA
output, and Git metadata are namespaced by `sessionId`/`runId` below
`/var/lib/mapache/runtimes/{identity}`. Private roots reject symlinked
ancestors before materialization, and private home/session archive targets are
disabled; the shared `/workspace` mount remains the user worktree only.

The frontend image catalog is configured from `functions/runnerCatalog.json` through `src/config/sessionImages.js`. It exposes only the supported `pi-chrome` image and Pi harness. Historical shell, SSH, Codex, web, and N64 records may remain in Firestore for readable old sessions and cleanup, but they are not catalog launch targets. New session creation is server-owned and resolves the marked `pi-chrome`/Pi image; legacy Chat and Goals capability flags are no longer advertised.

The supported runner key is `pi-chrome`. Session list UI derives runner tags directly from the normalized key by splitting on hyphens, so the supported image renders `pi` and `chrome` tags without adding a view-specific mapping.

The backend is authoritative for image selection. `functions/runnerCatalog.helpers.js` and `functions/runnerImages.helpers.js` resolve the exact `pi-chrome` entry and Pi harness. Client `imageKey` and `image` fields cannot select another image; provisioning and queued-worker paths repeat the canonical identity check and reject unsupported or arbitrary runner records before any Cloud Run request. Historical records remain readable for status and cleanup without becoming launchable.

Workspace MCP server config is managed from the top-navigation MCP dialog and stored on the workspace document. Session creation and restart snapshot that config into `MCP_CONFIG` for the runner. Legacy/shared runners write `/workspace/.mcp.json` for shared MCP discovery. Private automation runners instead write the generated Pi config below their private runtime root and launch the managed child with `--mcp-config`; they never replace the shared project file with generated credential-bearing content. The `pi-chrome` image bakes the exact `pi-mcp-adapter@2.32.1` package and exposes its image-owned `index.ts` entry through `PI_WEB_MCP_ADAPTER_PATH`; managed pi-web sessions pass that one path to the Pi SDK `additionalExtensionPaths` loader. The managed server does not start its legacy `<dataDir>/mcp.json` `McpBridge`, so the adapter is the only MCP transport and each configured server is started once. Its setup/editor, auth actions, project enable/disable, and bearer-token write paths are read-only/refused in managed mode; Mapache remains the owner of workspace config and Google token refresh/materialization.

Workspace-bound Google MCP services are injected during Functions provisioning after a server-side refresh. The runner receives an ephemeral `GOOGLE_MCP_ACCESS_TOKEN`; local mode starts `/app/google-workspace-mcp/server.mjs` over stdio and passes enabled services/scopes through non-secret environment values. No Google token is written to `MCP_CONFIG`, `/workspace/.mcp.json`, or persisted pi-web UI config: the adapter uses the runner's `bearer_env` reference and the local wrapper asks Mapache for a bounded refresh after a 401. Pi's legacy `/root/.pi/agent/mcp-oauth` directory has a dedicated hidden archive target, while private automation OAuth state is local-only and namespaced with the run. `GET /google/mcp/status` performs local initialize/tools-list readiness evidence and exposes only service state, adapter, and safe account metadata behind the shutdown-token gate. See [Google Workspace MCP connectivity](./google-workspace-connectivity.md).

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
- `gh`, so agent sessions can use the GitHub CLI for issue, PR, and repository workflow commands without manual installation
- `gzip`
- `openssh-client`
- `python3` as the shared Python runtime contract
- `make`
- `g++`
- `ripgrep`
- `tar`
- `chromium`, `openbox`, `tint2`, `x11-utils`, `x11vnc`, `xvfb`, `novnc`, and `websockify` in Chrome images for the headed desktop and authenticated browser bridge

`curl` is intentionally installed by default because users expect it in the browser terminal, and installing it manually inside ephemeral sessions is a poor default experience.

`make` and `g++` are present because `node-pty` and terminal-adjacent dependencies may require native build support during image construction.

The `pi-chrome` Dockerfile runs `python3 --version` during image construction, and `session-runner/lib/runnerImageBaseline.test.js` verifies the supported image's build contract. The explicit command contract is `python3`; Mapache does not currently guarantee a bare `python` alias because repository workflows and tooling use `python3` directly.

The supported `pi-chrome` image installs Pi Agents with:

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

The images retain npm, git, search tools, and native build tooling for ordinary
terminal and upstream agent workflows. Mapache does not install or reconcile a
managed Goal package at build or startup. Native Goals remain inside the
embedded upstream application and are persisted as part of its UI snapshot.

The image also includes Chromium, noVNC, preview/QA tooling, and the managed
pi-web-ui runtime used by every newly created session.

## Runner Server Layout

`server.js` must construct workspace authority before activity tracking, then
construct Git and other activity consumers. Reading `activity` before its
initialization crashes Node before the HTTP listener opens and surfaces as a
Cloud Run port-8080 startup failure. `lib/serverBootstrap.test.js` executes the
entrypoint with external services stubbed to catch this wiring regression.
Fixes require rebuilding `pi-chrome`; existing services need a new revision
through restart or recreation.

The container entry point is still `session-runner/server.js`, but it is now a bootstrap/router layer rather than the full runtime implementation. Feature code lives under `session-runner/lib/`:

- `terminal.js` owns PTY lifecycle, WebSocket replay, and the terminal iframe HTML.
- `preview.js` owns static/proxy preview modes and the browser log buffer.
- `workspace.js` composes workspace restore and sync behavior. Published checkpoint restore lives in `agentCheckpointRestore.service.js`; path filtering lives in `workspacePath.helpers.js`, archive target construction and tar upload/restore live in `workspaceArchives.service.js`, GitHub workspace reconstruction lives in `workspaceGithub.service.js`, harness-backed auth/home materialization and secret-file inventory live in `workspaceAuth.service.js`, and per-session Pi model-scope restore/persistence lives in `piModelScope.service.js`.
- `git.js` composes runner Git behavior. Manual status/stage/commit/pull/push/PR preparation stays in the facade, while automatic Pi branch/commit/push/PR lifecycle lives in `gitAutomation.service.js`. Command execution, GitHub askpass auth, PR creation helpers, porcelain status parsing, and branch/path/payload validation live in focused `git*.js` modules beside it. Preview log/SSE collection and static share export similarly live in `previewLog.service.js` and `previewShare.service.js`, leaving `preview.js` as the mode/config facade.
- `pi.js` composes only the startup-owned Pi seeded-skill materializer. Mapache
  package, skill, subagent, model, Goal, and Chat control services are not
  included in the runner.
- `harnesses/index.js` and `harnesses/metadata.js` resolve the active runner
  harness and define the retained auth/MCP startup contract.
- `workspaceSkillCatalog.js` selects harness-neutral `github` and `web` skill profiles from workspace source mode and runner capabilities. Canonical skill Markdown lives under `session-runner/seeded-skills/` and is materialized into the Pi workspace path.
- `activity.js`, `config.js`, `processes.js`, `services.js`, and `utils.js` hold shared runner plumbing.

Route paths, environment variables, storage paths, and startup order remain controlled by `server.js`. The runner receives the fixed Pi harness contract; historical terminal metadata is not used to select a new runner family.

For GitHub-backed Pi sessions, automatic branch preparation resets and cleans the worktree before harness-owned MCP and skill files are materialized. Keep generated `.mcp.json` creation after that destructive Git preparation step; otherwise `git clean -fd` removes the generated MCP configuration before Pi starts and the session reports zero registered servers.

GitHub restart restoration preserves the workspace cache before that cleanup. The `.git` archive is stored with workspace-relative `./.git/**` entries and must be extracted at the workspace root, not inside `/workspace/.git`, or it creates an invalid nested `.git/.git` repository. When a runner resumes the same session automation branch, it keeps that branch and its worktree unchanged. When it must create a new automation branch, it stashes restored tracked and untracked changes before resetting to the selected remote base and reapplies them after creating the branch. A stash conflict fails startup with the stash retained instead of silently replacing cached files.

The `pi-chrome` Dockerfile packages `session-runner/lib/` and `session-runner/routes/` with `server.js`. Route modules are required startup dependencies; omitting either directory causes the container to exit before the Cloud Run startup probe can succeed. Changes under either shared directory require rebuilding `pi-chrome`, and existing session revisions retain their previously bundled files until recreated.

The runner exposes a backend-only `POST /workspace/sync-down` route protected by `SESSION_SHUTDOWN_TOKEN`. Functions calls this route after file-browser uploads or editor saves so newly written Cloud Storage objects materialize into the active `/workspace` filesystem that the terminal process sees. The existing periodic sync loop still uploads local terminal changes back to storage and preserves newer remote objects when it encounters them.

Workspace files are synchronized and checkpointed through the existing storage
boundary, but the parent Mapache UI no longer lists or edits them through a
duplicate file browser. The embedded upstream Agent owns live file browsing and
Git for marked sessions. Historical unsupported runner records remain available
for cleanup only; no new SSH file-backed runner can be created.

The `pi-chrome` image copies `session-runner/seeded-skills/` into `/app/seeded-skills/` so the harness-neutral catalog is available at runtime. The seeding path treats these files as optional startup aids: if an expected seed file is absent, the runner logs a warning, skips that seed, and continues starting the session. Changes to the catalog require a new `pi-chrome` revision; existing Cloud Run session revisions retain the catalog bundled in their current image.

## Terminal Runtime

The container runs `session-runner/server.js`.

It starts an Express server on `PORT`, serves the terminal iframe page, and exposes a WebSocket at `/terminal`. The runner keeps one active `node-pty` process per container instance. Browser WebSocket connections attach to that PTY, and closing or recreating the browser iframe detaches only the socket instead of killing the process.

Browser access to the terminal page, `/terminal` WebSocket, `/preview/*`, `/healthz`, and `/capabilities` is gated by short-lived HMAC tokens minted by the authenticated Cloud Functions API. The runner receives a per-session `SESSION_BROWSER_TOKEN_SECRET` environment variable and validates the `mapache_access` query parameter or the HttpOnly `mapache_access` cookie before serving those browser surfaces. The query token is used for the initial iframe load; the cookie lets preview pages load relative assets and lets the terminal WebSocket reconnect without exposing the internal runner management token. Backend-only lifecycle, sync, checkpoint, source-automation, and MCP/auth routes use the separate `SESSION_SHUTDOWN_TOKEN` header gate.

The runner stores a bounded raw-output replay buffer so a newly loaded iframe can redraw recent terminal output after reconnecting. The default replay limit is `1000000` characters and can be changed with `TERMINAL_REPLAY_LIMIT`. Automatic reconnects from the same iframe skip replay to avoid duplicating visible terminal content. If the shell process itself exits, the runner closes connected sockets and the next fresh iframe connection starts a new PTY.

This persistence is scoped to the current Cloud Run container instance. Active session services request one minimum instance, so ordinary traffic scale-down does not end the PTY before the backend idle timeout. A Cloud Run revision replacement, service stop, platform restart, or container crash still ends the current PTY process.

Runner bootstrap is lifecycle-aware. `session-runner/lib/runnerLifecycle.js` catches preparation failures before the server listens and asks `session-runner/lib/activity.js` to record `runtimeState: "failed"`, the compact runtime error, and zero active sockets. When the stored lifecycle was `running`, `restarting`, or `resizing`, that transaction also changes it to `update_failed`; initial provisioning remains `provisioning` so the Functions worker can own the normal `provision_failed` transition. This prevents a Cloud Run service whose revision is configured as ready but whose instances cannot start from remaining displayed as a healthy running session.

The runner reports terminal and embedded Agent activity back to the session document in Firestore. WebSocket connects and disconnects update only `activeSocketCount`, `lastConnectedAt`, and `lastDisconnectedAt`; transport reconnects do not count as user activity because Cloud Run can recycle long-lived WebSockets. Terminal input and PTY output, successful Agent mutations, meaningful Agent WebSocket frames, and background completed-turn progress update `lastActivityAt` with a short debounce. Keepalives, health/status polling, reconnects, and checkpoint metadata are deliberately excluded. The runner records `runtimeStartedAt` after acquiring its generation/boot authority; the scheduled idle reaper uses that baseline and actual activity for marked sessions, with session update/creation timestamps as compatibility fallbacks for older runners. Changes to this path require a new `pi-chrome` revision and existing Cloud Run services must be restarted or recreated to receive it.

Cloud runner sessions also expose an authenticated read-only `/metrics` WebSocket. `resourceMetrics.service.js` samples Linux cgroup CPU and memory counters every two seconds while a client is subscribed, and `resourceMetricsWebSocket.js` broadcasts the safe `{type: "metrics", ...}` payload without attaching to the PTY or updating session activity. CPU is normalized against the cgroup CPU limit and memory against the cgroup memory limit. If the container does not expose bounded cgroup memory data, the socket reports `resource_metrics_unavailable`; it never falls back to host-wide memory values.

## Chrome Runtime

Chrome-capable images run one workspace-owned headed Chromium desktop alongside the terminal. `chromeDesktop.js` starts Xvfb (`:99`) and waits for its display socket before launching openbox, tint2, Chromium, and x11vnc. It supervises the complete process set: Chromium keeps its one automatic restart, while openbox, tint2, and x11vnc use bounded exponential-backoff retries controlled by `CHROME_DESKTOP_RESTART_MAX_ATTEMPTS` and `CHROME_DESKTOP_RESTART_BACKOFF_MS`. Xvfb failure and retry exhaustion fail the desktop. Child stderr is consumed, while process-exit state and errors exposed through `/browser/status` remain compact and sanitized. Chromium uses `/var/lib/mapache/chrome/profile`, CDP uses `127.0.0.1:9222`, and x11vnc uses `127.0.0.1:5900`. The noVNC assets are served through the runner on port 6080, never exposed as a raw Cloud Run port. The configured environment contract is `CHROME_PROFILE_DIR`, `CHROME_DISPLAY`, `CHROME_CDP_HOST`, `CHROME_CDP_PORT`, `CHROME_STARTUP_TIMEOUT_MS`, `CHROME_DESKTOP_RESTART_MAX_ATTEMPTS`, `CHROME_DESKTOP_RESTART_BACKOFF_MS`, `CHROME_VNC_HOST`, `CHROME_VNC_PORT`, `CHROME_NOVNC_PORT`, `MAPACHE_BROWSER_CDP_URL`, `MAPACHE_BROWSER_STATUS_URL`, and `MAPACHE_BROWSER_ACTIVITY_URL`.

Cloud Run does not permit the nested PID/network namespaces Chromium's Linux process sandbox requires, so the headed browser retains `--no-sandbox` and relies on the per-session Cloud Run service boundary for workload isolation. Both Chrome images install `/etc/chromium/policies/managed/mapache.json` with `CommandLineFlagSecurityWarningsEnabled` disabled so Chromium does not cover browser content with the corresponding command-line security warning. The image build validates this policy before running the browser smoke test.

The browser surface is protected by the same per-session HMAC browser token as the terminal and preview. `/browser/` serves authenticated noVNC, `/browser/status` reports safe desktop/CDP readiness, `/browser/activity` records meaningful agent browser actions, and the `/browser/vnc` WebSocket bridges only to loopback x11vnc. Browser runtime readiness requires a live CDP endpoint, all required desktop processes, and a reachable loopback VNC port; a later supervised process exit transitions the runtime away from `ready` until the desktop and both probes recover. A dropped VNC bridge is closed so noVNC can reconnect to a replacement x11vnc process. CDP and VNC ports are not public. `mapache-chrome-status` reports only readiness and browser version and exits nonzero when CDP is unavailable.

Chrome profiles are not part of the visible workspace tree or the general home archive. Legacy/shared runners use the isolated archive target `{workspace.storagePrefix}/.mapache-internal/chrome/chrome-profile.tar.gz`; private automation runners use `/var/lib/mapache/runtimes/{identity}/chrome/profile` and do not publish the profile to the shared prefix. The runner stages and sanitizes legacy profiles before atomic restore, then serializes periodic and final snapshots. Profile extraction uses GNU-compatible ownership and permission guards, and reports the tar process error ahead of any secondary stream-close error. Cache, crash, download, lock, socket, and other transient paths are excluded. Shell sessions never create, restore, or overwrite the shared target.

The Chrome DevTools MCP package is baked into both Chrome images at `chrome-devtools-mcp@1.6.0`. The runner materializes a reserved `chrome-devtools` MCP server with `--browser-url http://127.0.0.1:9222`, disables usage statistics/update checks, and attaches to the existing browser rather than launching another one. Chrome-image QA uses Playwright `connectOverCDP`; it closes only the temporary QA page and writes its normal reports under `$MAPACHE_QA_DIR`.

The authenticated `/agent` gateway returns `Referrer-Policy: strict-origin-when-cross-origin` so the embedded pi-web-ui can validate the parent origin for its postMessage access bridge. It still strips `referer`, `origin`, cookies, and access query parameters before forwarding requests to the private upstream UI. Checkpoint restore validates Pi settings as JSON objects while accepting array-shaped UI catalogs such as `ui/subagent-templates.seeded.json`.

The `pi-chrome` Dockerfile runs `bin/check-chrome-runtime.js` and `bin/chrome-smoke.js` during image construction. The smoke check is bounded and credential-free: it verifies CDP, loopback VNC, multiple page targets, browser cookie/local-storage interaction, profile file creation, and clean desktop shutdown. Profile archive restore and restart behavior remain covered by runner persistence tests and the canary checklist.

The supported Pi runner starts its terminal process in Pi resume mode:

```text
pi -c
```

For Pi runners, that process is Pi resume mode:

```text
pi -c
```

Cloud Functions sets `TERMINAL_COMMAND` and JSON-array `TERMINAL_ARGS` when provisioning each session. The supported `pi-chrome` runner receives:

```text
TERMINAL_COMMAND=pi
TERMINAL_ARGS=["--session-dir","<per-session-pi-dir>","-c"]
```

Pi conversations are scoped to the Mapache session, not to the user or workspace. New Cloud sessions receive an empty per-session Pi session directory and start a fresh Pi JSONL conversation. The session document stores the session-specific Pi storage prefix and, after Pi creates it, the bound JSONL path. If the same Cloud session is opened from another tab/device or its Cloud Run instance restarts, the runner restores that per-session archive and resumes that Cloud session's Pi conversation. Mid-turn process, stream, or PTY state is not durable; restart resumes from the last completed Pi session entry.

Pi's native model settings remain part of the restored upstream state. The
runner may normalize the session-owned `enabledModels` scope while restoring
legacy Pi state, but it does not expose a Mapache model editor or model API.
Current model selection and model metadata belong to the upstream Agent UI.

For connected GitHub workspaces, the runner retains internal source
reconstruction and the configured GitHub automation branch/PR flow. The
embedded upstream Agent owns live Git browsing and editing; Mapache does not
expose a competing parent Git manager or manual Git-control API.

The browser terminal uses `@xterm/xterm` instead of a plain text `<div>`. This is important because PTY output includes ANSI escape sequences, cursor movement, alternate screen buffers, colors, and TUI control codes. Rendering raw PTY output as text caused artifacts such as `[0m[2m-`.

The terminal page also loads `@xterm/addon-fit` from the runner and fits the xterm viewport to the actual iframe dimensions before sending resize events to the PTY. It inlines the critical xterm helper-textarea, viewport, and screen CSS in the runner HTML as a fallback, and reapplies visual-only helper-textarea styles after render. Keep xterm in charge of helper textarea position, dimensions, and value changes because mobile soft keyboards and composition input depend on that internal state. Avoid returning to hand-estimated character cell sizes; the Pi TUI depends on the browser terminal and PTY agreeing on rows and columns so typed input and long model output stay visible.

## Upstream agent runtime

The embedded upstream application owns conversations, prompts, tool calls, live
files/Git, model selection, skills, extensions, subagents, and native Goals. Pi
JSONL history is captured and restored as storage state, but the runner does not
tail it into a second Chat UI or inject prompts through a Mapache Chat socket.
The only managed child is the upstream pi-web-ui process on the marked path.

## Managed pi-chrome runtime

`session-runner/Dockerfile.pi-chrome` is the supported managed runner. It combines Pi, Chromium, preview, browser QA, and the embedded pi-web-ui runtime. The image sets the runner capability contract to:

```json
{"terminal":true,"preview":true,"previewQa":true,"functions":true}
```

The shared runner server still owns the terminal, sync, protected shutdown,
checkpoint, Preview, Chrome, and QA endpoints. Web behavior is enabled by
environment:

- `PREVIEW_ENABLED=true`
- `PREVIEW_BASE_PATH=/preview`
- `PREVIEW_STATIC_ROOT=/workspace/build`
- `PREVIEW_INJECT_LOGGER=true`
- `PREVIEW_LOG_LIMIT=500`
- `MAPACHE_RUNNER_URL=http://127.0.0.1:8080`
- `MAPACHE_PREVIEW_URL=http://127.0.0.1:8080/preview/`
- `MAPACHE_QA_DIR=/workspace/.mapache/qa`
- `MAPACHE_BROWSER_QA_COMMAND=/usr/local/bin/mapache-preview-qa`

When preview is enabled, the runner exposes:

- `GET /capabilities` for live runtime capability discovery.
- `GET /preview/status` for static preview readiness.
- `GET /preview/qa/status` for browser automation readiness and the last QA run state.
- `GET /preview/logs` for the in-memory browser console log ring buffer.
- `GET /preview/logs/stream` for server-sent browser console log events.
- `POST /preview/logs` for the injected browser logger.
- `GET /preview/*` for static files under `/workspace/build` with SPA fallback to `index.html`.
- `POST /preview/share` for backend-only static preview export to Cloud Storage. This route requires the runner shutdown token and is not available through browser preview access.

The web images now provide a supported browser QA command at `/usr/local/bin/mapache-preview-qa`. The command launches Chromium through Playwright with fixed desktop/mobile viewport defaults, supports basic `goto`, `click`, `fill`, `press`, `waitFor`, and `screenshot` actions from a JSON spec, writes screenshots plus `report.md` and `report.json` under `$MAPACHE_QA_DIR/latest`, and updates `$MAPACHE_QA_DIR/last-run.json` so the runner can report whether the last QA execution passed or failed.

The disposable `pi-web.failure-recovery` case has a deterministic fault harness. It is enabled only when a marked `pi-web-ui-v1` session has both `QA_CASE=pi-web-failure-recovery` and `MAPACHE_QA_FAULT_HARNESS=pi-web-failure-recovery-v1`. The authenticated Functions bridge exposes `GET`/`POST /api/workspaces/{workspaceId}/sessions/{sessionId}/qa/faults`; it proxies to the runner's shutdown-token-protected `GET`/`POST /qa/faults` routes. The harness supports one-shot storage-publication failure, writer revocation, uncertain replacement, and forced process loss/no-auto-resume, plus a bounded short-lived browser-access TTL fixture. One-shot faults are armed and consumed transactionally in the session document, and ordinary or unmarked sessions return unavailable rather than exposing injection controls. Use `e2e/qa/scripts/qa-fault-status.json`, `arm-qa-fault.json`, `revoke-qa-writer.json`, and `force-qa-loss.json` only against the disposable marked session.

`GET /capabilities` includes preview QA capability metadata such as the command path, Chromium executable path, supported viewports, and supported actions. `GET /preview/status` now embeds a `qa` block whose `state` distinguishes `preview_not_running`, `browser_automation_unavailable`, `browser_ready`, and `qa_execution_failed`.

The `pi-web` static preview serves generated output from `/workspace/build`. The seeded `mapache-preview-build` skill instructs agents to emit browser-loadable output there and to configure relative asset bases, such as Vite's `base: "./"`, so bundled assets resolve correctly under `/preview/`.

Share Preview uses the same static preview root. The runner reads the active preview config, accepts only static mode, requires `/workspace/build/index.html` or the configured static root's `index.html`, skips symlinks, and uploads regular files under that root to the storage prefix supplied by the authenticated API. The V1 export is bounded to 1000 files and 100 MiB. It does not export proxy-mode upstream responses, the full workspace, hidden session state, auth material, environment variables, or archive-backed internal directories outside the static root.

Public shared previews are served by the Cloud Functions API from `publicPreviews/{token}` metadata and Cloud Storage objects. Preview tokens are unguessable and expire after 30 days; expired previews return HTTP 410. There is not yet a dedicated garbage-collection job for expired preview objects, so storage cleanup is a maintenance follow-up if preview volume grows.

HTML responses from the static preview receive a small development logger script when `PREVIEW_INJECT_LOGGER=true`. It forwards `console.log`, `console.info`, `console.warn`, `console.error`, `window.onerror`, and unhandled promise rejections to the runner log buffer. QA agents can combine these logs with the supported browser QA command's screenshots, failed-request capture, and interaction checks without needing to scrape the terminal.

Agents can switch the preview gateway from static-file serving to a local app/API server by writing `/workspace/.mapache/preview.json`:

```json
{
  "mode": "proxy",
  "upstream": "http://127.0.0.1:3000"
}
```

Only localhost upstreams are accepted. In proxy mode, `/preview/*` forwards HTTP methods and paths to the upstream server, so a framework dev server, Express app, or function emulator can serve both browser routes and API routes through the same Preview canvas. Removing the file, or setting `mode` to `static`, returns the preview to static serving from `/workspace/build` or a valid `staticRoot` in `/workspace/.mapache/preview.json`.

On startup, GitHub-backed workspaces select the shared `github` profile containing `mapache-github-issue`, the default workflow skill for actionable implementation requests. It reuses a supplied issue or creates one after duplicate search and clarification, confirms the base is current, preserves the runner-created `mapache/*` branch, implements and verifies the scoped change, and ends with a local commit for runner exit publication. An explicit `hotfix` or `directly on main` instruction instead authorizes a tested commit and push directly to `main` without automatic issue or PR creation. Blank workspaces do not select this profile. The runner copies selected catalog files into the active harness's native workspace path only when a workspace-local file is missing.

On startup, `pi-web` also seeds three workspace-local Pi skills when they are missing:

- `mapache-preview-build`
- `mapache-api-hosting`
- `mapache-preview-qa`

These files are written under `/workspace/.pi/skills/{skill-name}/SKILL.md` after workspace restore and before the Pi terminal process starts, so Pi can discover them in new `pi-web` sessions. `mapache-preview-qa` now points agents at the supported `mapache-preview-qa` command instead of embedding an inline Playwright launch script. Existing user-edited skills with the same names are not overwritten.

Build and push the image with:

```bash
gcloud builds submit session-runner \
  --project pi-agents-cloud \
  --config session-runner/cloudbuild.pi-chrome.yaml
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
- `MCP_CONFIG`
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

Provisioned sessions also receive `WORKSPACE_SYNC_ROLE` from the Functions lease controller. `writer` owns the workspace's sync-writer lease; `reader` remains available for terminal and inspection work without taking ownership; `none` is used for sessions that cannot provision. The runner skips all worktree/archive uploads and deletion reconciliation for `reader` and `none` sessions, while startup restore and explicit `/workspace/sync-down` remain available. Existing sessions without this field use the compatibility default `writer` so their current upload behavior is preserved until they are recreated or restarted. Functions persists the role on the session and the owner/lease ID on the workspace, releases it on stop/delete/provisioning failure, and periodically reconciles stale owners.

Workspace records also carry an app-owned `homePolicy` field. New workspaces default to a persistent `$HOME` rooted at `/root`, archived under `{workspace.storagePrefix}/.mapache-internal/home/home.tar.gz`. The workspace owns this materialized home tree; sessions receive a resolved copy on creation and restore/archive that same tree through `HOME_STORAGE_BUCKET`, `HOME_STORAGE_PREFIX`, `HOME_SYNC_MODE`, and `HOME_ARCHIVE_NAME`. The archive is runtime state, not ordinary upstream workspace content; internal `.mapache-internal/` objects remain hidden from user-facing file surfaces.

As of 2026-06-19, new writes use canonical `.mapache-internal` and `.mapache-directory` names. The backend and runner still read the historical `.mapahce-internal` and `.mapahce-directory` paths so existing workspaces, archive objects, and empty-directory markers continue restoring correctly. Client file APIs, sync filters, and Git-path validation must treat both spellings as hidden internal/runtime state.

Workspace and session records may also carry non-secret env maps. During Cloud Run provisioning, the backend merges them as image defaults, then workspace env, then session env, then Mapache-reserved runtime env. Session env can override workspace env, but neither can set reserved variables such as `HOME`, `WORKSPACE_DIR`, `SESSION_ID`, storage prefixes, runner tokens, terminal command vars, or preview/system vars.

Generic environment keys are different from those non-secret maps: only entry IDs are stored on workspace/session records, while their values remain in the owner's private Firestore collection. `functions/cloudRun.service.js` resolves selected values at provisioning or restart time and injects them into the new Cloud Run revision. Existing services need a restart or reprovision to receive changed selections or values; no runner image change is required.

The parent Mapache shell no longer lists, uploads, downloads, or edits workspace
files. The embedded upstream Agent reads and writes the live `/workspace` tree;
the runner's periodic/checkpoint sync and Cloud Storage manifests preserve that
tree for restart and migration. During sync-up, the runner reconciles local
changes against the workspace storage policy and retains the existing hidden
archive/internal-path rules.

This behavior now needs to be read together with workspace source mode:

- For `blank` workspaces, Cloud Storage remains the durable source of truth.
- For `github` workspaces, Cloud Storage is a cache and resumability layer for the last active local state. GitHub is the durable repository source of truth.

Cloud Storage does not store real directories, so the runner may retain
`.mapache-directory` marker objects inside synchronized directories. The
runtime still recognizes the legacy `.mapahce-directory` marker while old
objects remain in storage; these markers are not a parent-shell UI contract.

High-cardinality runtime directories are not synced as individual Cloud Storage objects:

- `/workspace/node_modules`
- `/workspace/.git` for GitHub-backed workspaces
- `$HOME`

High-cardinality runtime directories remain archive-backed:

- `/workspace/.pi/npm` and `/workspace/.pi/git` when present, under the existing
  hidden archive prefix.

Upstream and terminal package behavior is not managed by a Mapache web
extension manager. Runtime cache directories remain hidden/archive-backed and
ordinary workspace configuration remains available to the upstream Agent.

The runner restores these directories from gzip-compressed tar archives during startup and uploads them as single archive objects on the slower archive sync interval. It also forces an archive upload during the protected shutdown sync before a session service is deleted.

`/workspace/node_modules` and `/workspace/.git` remain workspace-scoped. Their
archives live under `.mapache-internal/archives/` inside the workspace storage
prefix, and that internal directory is hidden from browser-facing surfaces.

The legacy `$HOME` archive includes Pi auth, settings, shell state, and
per-session Pi conversation directories. It excludes mutable caches, runtime
package trees, and other transient state. Treat the archive path as sensitive
runtime state because it can contain credentials and command history; it lives
under the hidden workspace internal prefix and is never exposed to the browser.
Private automation mode forces an ephemeral home and leaves its private
conversation/auth roots out of the shared archive path.

Each legacy Cloud session uses a unique Pi conversation directory under
`$HOME/.pi/agent/mapache-sessions/{sessionId}`. Private automation sessions use
their run-scoped agent-state session root instead; both launch Pi with
`--session-dir $PI_SESSION_DIR -c`, keeping each conversation outside the
mounted worktree.

Pi provider auth persists in Firestore at `users/{uid}/private/agentAuth`. The `providers` map matches Pi's `$HOME/.pi/agent/auth.json` object shape exactly (`providerKey -> credential object`) for native materialization, while the `entries` map stores named credentials as `entryId -> {providerKey, label, credential}` so users can keep multiple credentials for one provider and choose which one a session should use. The backend API writes web-added API keys and tokens as `{type: "api_key", key: "..."}` and records them as named entries. It also supports OpenAI ChatGPT Plus/Pro Codex subscription login through OpenAI's device-code flow and saves completed OAuth credentials for `openai-codex` as `{type: "oauth", access, refresh, expires, accountId}` entries. The Authentication Center lets users delete named credentials and restart the device-code login directly from an existing OAuth entry. Deletion replaces the complete Firestore `providers` and `entries` map fields so removed nested keys cannot survive merge semantics; when another entry exists for the same provider, the newest remaining credential becomes the provider value. Sessions store `authSelection` (`{harness, providers}`), and the runner materializes either the selected entries or all provider values into the Pi auth file with `0600` permissions on startup and during periodic sync. The runner receives `OWNER_UID`, and the backend sets `PI_CODING_AGENT_DIR=$HOME/.pi/agent` so Pi resolves auth storage to the materialized home tree. This makes CLI/TUI `/login` additions visible to the web UI after runner sync while letting web-added credentials appear in already-running sessions after the runner sync interval.

Private automation sessions use the canonical provider selection on each boot,
materialize it into their run-scoped Pi directory, and never import local
restored auth. This keeps fresh runs on the existing broker/revocation boundary
without copying credentials into the shared worktree.

GitHub CLI auth is app-managed rather than archive-managed. Users save a `github-cli` token in the Authentication Center and select it for a Pi session. The runner materializes that selected token to `$HOME/.config/gh/hosts.yml` with `0600` permissions, and removes that file when no GitHub CLI token is selected for the session. The `$HOME` archive excludes `.config/gh/hosts.yml`, so a manual `gh auth login` inside the terminal is not the durable credential source. This keeps GitHub CLI credentials scoped through the same saved-entry and per-session selection UI as other agent auth, avoids silently persisting terminal-entered tokens in workspace home archives, and lets users rotate or delete the saved token centrally. GitHub App workspace clone, push, and automatic PR flows still use short-lived installation tokens supplied by the backend and do not depend on the user's `gh` token.

For GitHub workspaces, treating `/workspace/.git` as archive-backed state is also a consistency boundary. The app should not expose Git internals through normal file listing or per-file object sync. Restoring `.git` from a single archive is safer than trying to mirror Git internals as ordinary Cloud Storage objects. Normal sync now skips `.git` paths for GitHub workspaces, and archive upload stores `.git` under the hidden internal archive prefix while skipping obvious transient `*.lock` files where practical. Private automation runners reserve a run-scoped `/var/lib/mapache/runtimes/{identity}/git/repository` root and do not publish a workspace `.git` archive; private Git migration/capture remains the dedicated follow-up boundary.

This keeps dependency installs, Git metadata, and Pi Agent state available without creating thousands of Cloud Storage objects for `node_modules` or `.git`. Archive-backed changes can lag normal file sync by up to `ARCHIVE_SYNC_INTERVAL_MS` unless the session is stopped cleanly, which triggers the final archive sync.

The detailed GitHub workspace architecture, including one-active-session enforcement and cache semantics, lives in [github-workspaces.md](./github-workspaces.md).

The retired Mapache package-manager design is retained only as historical
context in [pi-extension-manager.md](./pi-extension-manager.md); it is not an
active API or runtime contract.

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

When a session is created, `functions/index.js` validates the request, reserves
the single workspace runner, writes the session record with
`provisioningState: "queued"`, and returns without waiting for Cloud Run
readiness. The `provisionQueuedSession` Firestore trigger provisions the
server-selected `pi-chrome` image. Cloud Run request construction,
service-account resolution, resource mapping, and runner environment assembly
live in `functions/cloudRun.service.js`; credentials, Google/MCP materialization,
and GitHub source/automation behavior remain in their focused services. The
create-session payload retains resource/environment fields, but runner
selection is not client-controlled. New workspace records carry the fixed
`agentUiVersion` marker; unsupported historical sessions remain readable without
a start/restart path.

Session creation accepts `operationId` (with `provisioningOperationId` and `idempotencyKey` as compatibility aliases). The backend persists the canonical `provisioningOperationId` and derives the session document id from it, so repeated requests for one operation return the existing session instead of creating a second record. Provisioning also persists `provisioningAttempt`, `provisioningState`, timestamps, the Cloud Run operation name, and a safe retryability/error result. A transaction claims a pending or retryable attempt before the Cloud Run create request; concurrent calls with an active operation either wait on the recorded Cloud Run operation or return without issuing another create request. Completed operations return the stored session result.

The `provisionQueuedSession` Firestore trigger watches `workspaces/{workspaceId}/sessions/{sessionId}` writes but only handles records explicitly marked `status: "provisioning"` and `provisioningState: "queued"`. It rejects unsupported historical or forged runner identities before loading any launch material, then loads the owning workspace and delegates to the same idempotent Cloud Run provisioning service. The API response contains the in-progress session; clients follow the session document until the worker writes `running`, `provision_failed`, or another terminal state.

GitHub workspaces still enforce one active managed agent session at a time so
two agents cannot race on cached Git state. Historical shell/SSH records may be
readable alongside it, but new session creation resolves the managed
pi-chrome/Pi runtime.

Each session service is named with the session id:

```text
session-<lowercase-session-id>
```

Cloud Run resource limits are derived from the session's CPU and memory settings. The accepted session resource catalog lives in `functions/sessionResourceCatalog.json` and is consumed by both Functions and the Vite frontend. Its current mappings are Small `1 vCPU / 2 GiB`, Medium `2 vCPU / 4 GiB`, and Large `4 vCPU / 8 GiB`; `1 vCPU / 8 GiB` and `4 vCPU / 1 GiB` are rejected as incompatible pairs. The catalog records the us-central1 on-demand rates of `0.000018` USD/vCPU-second and `0.000002` USD/GiB-second, equivalent to `0.0648` and `0.0072` USD per vCPU/GiB-hour. UI prices are estimates only and exclude free tier, discounts, network, storage, build, and other charges. CPU and memory remain the canonical session document fields, which lets older `1 vCPU / 1 GiB` records reopen as `Custom` without rewriting them.

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

The workspace Play/Pause control drives the canonical child session through the backend lifecycle routes. Starting a workspace with no child creates its first per-session Cloud Run service; starting an existing stopped or failed canonical session recreates that service from the stored session and workspace metadata. Pausing a running workspace deletes the per-session Cloud Run service, which terminates the `session-runner` container, then updates the Firestore session record to `stopped` and clears `serviceUrl`. If the Cloud Run service is already gone, the session is still marked stopped. The same recreate path is used for older records left in `update_failed` after a restart tried to patch a Cloud Run service that no longer exists. Sibling session records remain internal compatibility data and are not exposed as separate shell controls. Deleting a workspace runs the same Cloud Run cleanup for every child session before removing the workspace document tree and Cloud Storage objects under the workspace prefix when no other workspace references that prefix.

Before deleting a service, the backend calls the runner's protected `POST /shutdown` endpoint when the session has a `serviceUrl` and `shutdownToken`. The runner performs one final workspace sync, including archive-backed directories, and records `shutdownRequestedAt`; its already-admitted writer remains valid while the reservation is in the bounded `stopping`/`deleting` state so this final sync is not fenced by the lifecycle transition. The backend still proceeds with deletion if this best-effort request fails. Older sessions without a shutdown token skip this step.

When a session reaches the stopped path, the backend records an allocated usage interval under `users/{uid}/sessionUsage/{sessionId}` and marks the session with `usageAccountedAt`. The interval uses the session's active runtime multiplied by the configured Cloud Run CPU and memory limits, producing CPU seconds and memory GiB-seconds for the profile page. Resize operations accrue usage through the resize timestamp before changing the session's resource limits, so lifetime totals account for resource changes within a session. Restarting a stopped session accrues the previously stopped interval, clears `usageAccountedAt`, and starts a new active interval so the next stop records cumulative active usage without charging for time spent stopped. Running sessions and older stopped sessions without `usageAccountedAt` are still included dynamically by `/api/me`, so the profile can show lifetime and trailing-30-day usage without enforcing quotas. These counters intentionally do not use Cloud Monitoring utilization or billing-export data.

Usage reads depend on collection group indexes in `firestore.indexes.json`. The profile API queries `workspaces/{workspaceId}/sessions` by `ownerUid` to include running and unaccounted sessions, and admin-wide reporting can query `users/{uid}/sessionUsage` by `ownerUid` or `endedAt` to aggregate across users and trailing windows.

GitHub source reconstruction and internal automation still use protected runner
services and short-lived installation tokens. The in-memory token provider renews
through the Functions broker, and the image-owned `mapache-gh` and
`mapache-git-credential` commands scope credentials to the selected repository;
the runner no longer exposes
manual `/git/*` control routes. Live Git browsing and edits belong to the
upstream Agent application. Likewise, there are no runner skill, subagent,
package, or model CRUD routes; upstream settings and terminal workflows own
those features.

For GitHub workspaces, this final sync is especially important because it is the last chance to persist local working tree changes and refreshed `.git` archive state before the Cloud Run service disappears.

The shutdown request timeout defaults to 120 seconds because archive-backed dependency directories can be large. New deployments can override it with `RUNNER_SHUTDOWN_TIMEOUT_MS`.

## Idle Shutdown

Sessions automatically stop after a period without a connected browser terminal. New session records store:

- `activeSocketCount`
- `lastActivityAt`
- `lastConnectedAt`
- `lastDisconnectedAt`
- `idleTimeoutMinutes`
- `longRunning`
- `shutdownToken`

The default idle timeout is 60 minutes and can be changed for new sessions with the Cloud Functions environment variable `SESSION_IDLE_TIMEOUT_MINUTES`. The reaper caps each session's effective timeout at the current backend default, so older session records with a larger stored `idleTimeoutMinutes` value do not keep containers alive longer than the active default.

The scheduled Cloud Function `reapIdleSessions` runs every 5 minutes. It scans running session documents, treats a session as idle when the latest runtime activity timestamp is older than `idleTimeoutMinutes`, then reuses the same Cloud Run deletion flow as manual stop. Runtime activity includes terminal or Shell user input and output; connect/disconnect timestamps are diagnostics only. `activeSocketCount` is still recorded for visibility, but it is not allowed to keep a silent container alive forever. Shell is a separate persistent PTY exposed at the authenticated `/shell` page and WebSocket and shares the runner workspace with the agent PTY. Idle-stopped sessions are marked with `stopReason: "idle_timeout"` and `autoStoppedAt`. Each run logs separate `eligible`, `bypassed` (including `bypassedByReason`), `stopped`, and `failed` counts.

Idle is defined by the latest runtime activity timestamp, not browser connection presence. A long-running command that continues producing output keeps the session active. If no runtime activity is recorded past the timeout, the session service is deleted unless the managed session's explicit Long-running policy is enabled.

Cloud Run create, resize, and restart templates keep one instance allocated while the session lifecycle is active. Managed pi-web-ui services additionally use instance-based CPU allocation so explicitly enabled Long-running sessions can continue browser-independent work without an open request. Long-running defaults off; disabling it restores the normal idle policy, while enabling it records a `longRunning` bypass reason. Automatic pause uses the same protected quiesce, final checkpoint, confirmed deletion, and stopped transition as manual Pause, and manual Pause remains available in either state. Historical unmarked services retain the idle reaper and their final best-effort sync/delete behavior, but Functions does not launch replacements for them. Do not change the minimum instance count back to zero without adding durable PTY recovery and renewable startup credentials for private GitHub workspaces.

## Existing Sessions vs New Sessions

Pushing a new `:latest` image affects new pulls, but existing Cloud Run services need a new revision to pick it up. For an existing session service, update the service image to create a fresh revision:

```bash
gcloud run services update SERVICE_NAME \
  --image us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:latest \
  --region us-central1 \
  --project pi-agents-cloud
```

Workspace Play creates a session with the backend-resolved image. Existing sessions keep their current image until the Cloud Run service is updated or the session is recreated.

Existing services created before idle shutdown support do not have `SESSION_SHUTDOWN_TOKEN` in their environment and may not run runner code that reports activity. Recreate or update those Cloud Run services to pick up automatic activity reporting and best-effort final sync on stop.

Existing services created before warm active-session allocation keep `minInstanceCount: 0` until they are restarted, resized, or recreated through the updated Functions deployment. Existing revisions also need a rebuilt runner image before bootstrap failures can transition a stale `running` record to `update_failed`.

The same rule applies to the dedicated runner service account, source/sync/home
materialization variables, workspace/session variables, preview behavior, and
terminal defaults. Existing Cloud Run services do not automatically gain the
new managed `/agent/` gateway, checkpoint contract, image `ENV` values, or
runtime route set; they need a new revision or recreation before those changes
take effect.

Existing sessions do not gain the managed Chrome/Agent runtime when the catalog or image is updated. A session must be newly created or explicitly restarted onto `pi-chrome`; historical sessions retain their current runtime and archive behavior until they are cleaned up.

When `functions/` changes are part of a runtime/API change, deploy Cloud
Functions before handoff:

```bash
firebase deploy --only functions --project pi-agents-cloud
```

The relevant runtime locations remain the workspace-owned home/checkpoint
prefix, the versioned agent snapshot prefix, the workspace-file manifest
prefix, and the Chrome profile archive prefix. No package catalog or duplicate
agent-control API is part of the current deployment.

## Design Decisions

- Browser terminals should use a real terminal emulator. The app uses xterm.js so terminal programs and shell formatting render correctly.
- The runner keeps the PTY alive across WebSocket disconnects so frontend re-renders, iframe reloads, and brief network drops do not discard in-progress terminal work.
- Idle shutdown is controlled by Cloud Functions instead of browser timers so abandoned sessions are cleaned up even after the browser is closed.
- Runtime image selection is no longer user-facing for ordinary sessions. Cloud Functions selects and verifies `pi-chrome`; historical catalog entries remain only for readable metadata and cleanup. Bring-your-own-image support, if added later, must be a separate permission-gated untrusted-workload path rather than an extension of normal session creation.
- Containers include common developer tools by default when they are broadly expected in terminal workflows.
- Image-specific startup should be controlled by environment variables in the image where possible. This keeps the runner server shared while allowing the curated `pi-chrome` runtime to select its managed Pi/Chrome startup contract.
- Large generated runtime directories should use archive-backed sync instead of object-per-file Cloud Storage sync. This avoids slow file listings and excessive object counts for directories such as `node_modules`.
- Pi auth/settings may be user-scoped, but Pi conversation JSONLs must be session-scoped. New app sessions start with a fresh Pi conversation; the same app session can resume that conversation from its own archive.
- Native upstream model settings are restored as upstream-owned state; Mapache does not expose a duplicate model editor.
- GitHub workspaces should archive `/workspace/.git` instead of exposing it through normal file sync. That keeps Git state resumable without treating Cloud Storage as a Git database.
- Upstream skills and extensions remain configurable through the upstream Agent and terminal; only Mapache-owned runtime guidance is seeded when missing.
- Runtime package/cache directories, when present, remain archive-backed and hidden from parent-shell file APIs.
- GitHub workspaces should allow only one active session at a time until the app has an explicit multi-session Git isolation model.
- Existing sessions are not automatically recycled when the image config changes. This avoids surprising users by restarting active terminals.
- Chrome is a capability on the Pi/Codex harness, not a new terminal harness; the browser is shared by the user, MCP, and runner QA through authenticated attachments.

## Related Docs

- [Runner harnesses](./runner-harnesses.md)
- [Session runner architecture](./session-runner-architecture.md)
- [Backend API architecture](./backend-api-architecture.md)
- [GitHub workspaces](./github-workspaces.md)
- [Pi skills manager](./pi-skills-manager.md)
- [Pi extension manager](./pi-extension-manager.md)
- [SSH-backed sessions guide](./guides/ssh-backed-sessions.md)
- [Session resource benchmark](./guides/session-resource-benchmark.md)
- [Deployment](./deployment.md)

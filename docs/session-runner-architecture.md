# Session Runner Architecture

The session runner is a per-session Cloud Run container. Its entrypoint is
`session-runner/server.js`, which composes focused services, registers the
protected HTTP routes, and runs the ordered startup/shutdown lifecycle.

## Runtime boundaries

- `lib/runnerLifecycle.js`: ordered preparation, runtime admission, startup,
  quiesce, final checkpoint, and shutdown.
- `lib/workspace.js`: workspace restore/sync and writer-authority checks.
- `lib/agentSnapshot.service.js`, `lib/agentCheckpoint.service.js`, and
  `lib/agentCheckpointRestore.service.js`: immutable history/UI/settings
  capture, publication, validation, and restore.
- `lib/piWebUiProcess.js`: one managed upstream pi-web-ui child on the marked
  path; it does not launch a second Pi TUI or a Mapache chat/Goals process.
- `lib/agentGateway.js` and `lib/agentWebSocketGateway.js`: signed `/agent/`
  HTTP/WebSocket forwarding to the private upstream child.
- `lib/terminal.js` and `lib/shell.js`: terminal and independent shell PTYs.
- `lib/preview.js`, `lib/browserQa.js`, and `lib/resourceMetrics.js`: Preview,
  Chrome QA, and read-only metrics surfaces.
- `lib/workspaceAuth.service.js`, `lib/mcpConfig.service.js`, and
  `lib/piSeededSkills.service.js`: startup materialization that remains
  necessary for credentials, MCP, and image-owned runtime skills.
- `lib/git.js` and `lib/gitAutomation.service.js`: workspace reconstruction and
  internal GitHub automation. They are not a manual parent Git-control API.
- `lib/sshSession.js`: retained compatibility SSH terminal/port forwarding.

## Startup and lifecycle

The runner restores the published generation/boot-scoped checkpoint and
workspace state, materializes selected credentials and MCP configuration, seeds
only missing image-owned runtime skills, acquires writer authority, and then
starts exactly one managed upstream agent child for a marked pi-chrome runtime.
The upstream child listens on loopback `127.0.0.1:8787`.

The startup sequence fails closed if restore validation, credential/MCP
materialization, authority acquisition, the pinned adapter, or upstream health
checks fail. No startup path installs or patches `pi-goal-x`, starts Goals RPC,
tails a transcript into a second UI, or automatically launches a second Pi TUI.

Runners default to the legacy shared storage mode. Automation sessions set
`MAPACHE_RUNTIME_STORAGE_MODE=private` and a run-scoped identity; the runner
then derives HOME, Pi auth/settings, transcripts, MCP configuration, UI data,
control sockets, Chrome profile, QA output, and Git metadata below the private
`/var/lib/mapache/runtimes/{sessionId-or-runId}` root. User-authored skills and
project configuration remain in `/workspace`. Generated MCP JSON is written to
the private Pi config and passed to the managed child with `--mcp-config`, so
the shared `/workspace/.mcp.json` is never replaced by credential-bearing
runtime data. Private auth is materialized from the canonical Mapache stores on
each boot, while Google and GitHub access continues to use the existing
short-lived broker paths.

Quiesce rejects new work and waits for the managed child and writers to stop.
The runner then captures a final acknowledged checkpoint, closes browser/SSH
forwards, snapshots Chrome state when applicable, releases authority, and
exits. A forced loss leaves the last completed published checkpoint available;
restore never resumes an in-flight model/tool turn automatically.

## HTTP and WebSocket routes

The central `noServer` WebSocket dispatcher in `lib/webSocketUpgrade.js` keeps
terminal, browser/VNC, metrics, shell, and agent sockets from racing or
rejecting one another. The marked agent gateway accepts only signed,
generation-bound access and exact trusted origins. It strips browser bootstrap
credentials and injects a private upstream token. The parent bridge carries
only readiness, renewal, and safe status/error messages; it does not implement
the upstream chat protocol.

Runner routes are limited to retained lifecycle and integration boundaries:

- health/status, capabilities, runtime activity, and checkpoint status;
- terminal, shell, browser/VNC, Preview, metrics, and browser-QA routes;
- workspace restore/sync and internal source/automation operations;
- MCP status/materialization and credential materialization;
- the minimal agent auth-materialization route.

The old Chat WebSocket, Mapache Goals routes/RPC, manual file/editor routes,
manual Git-control routes, package CRUD routes, model editor routes, and
skills/subagent CRUD routes are not registered. Upstream owns those behaviors
inside `/agent/`.

## Persistence and safety

Agent snapshots use fixed internal roots for flat Pi JSONL sessions, allowlisted
non-secret Pi settings, upstream UI state, and only uploads referenced by
captured history. A manifest records generation/boot identity, paths, sizes,
hashes, and safe permissions. Complete JSONL prefixes may be captured while a
turn is live, but malformed interior records, traversal, unsafe symlinks, mixed
generations, and corrupt objects are rejected.

Workspace files and legacy `.git` remain under their existing Cloud
Storage/archive ownership. Marked workspace-file publication is generation/boot
fenced and cannot be replaced by stale delayed writers. Private automation
roots are never archive-published to the shared worktree prefix: home,
provider-key stores, MCP OAuth state, GitHub CLI auth, generated MCP config,
Chrome profile, sockets, SQLite/cache state, and private Git metadata stay
local to the run until their dedicated persistence work is applied. Persistent
agent snapshots continue to allowlist safe settings/transcripts and exclude
auth, tokens, connector state, locks, sockets, and cache databases.

## Invariants

- There is exactly one admitted managed upstream agent child per marked runner.
- Browser presence never determines runtime execution state.
- The runner never exposes shutdown credentials, private upstream tokens, or
  workspace secrets through browser responses.
- The shared HTTP server has one upgrade dispatcher; all socket surfaces remain
  explicit branches.
- Changes under `session-runner/lib/`, `session-runner/routes/`, or Dockerfiles
  require rebuilding affected images and recreating/revising existing services.

## Verification

- `npm --prefix session-runner run lint`
- `npm --prefix session-runner test`
- `npm run docs:check`
- rebuild the affected image with an explicit `--project pi-agents-cloud`

## Related docs

- [Runtime containers](./runtime-containers.md)
- [Runner harnesses](./runner-harnesses.md)
- [Backend API architecture](./backend-api-architecture.md)
- [Workspace Goals](./workspace-goals.md)

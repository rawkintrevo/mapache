# Frontend Architecture

This page owns the current frontend state, rendering, and workflow boundaries.
The embedded upstream application is the agent surface for marked workspaces;
Mapache owns the surrounding workspace/session shell and account connections.

## Canonical owners

- Startup and orchestration: `src/main.js`
- App state and reducer boundary: `src/state/appStore.js` and
  `src/state/initialState.js`
- Workspace selection, resource settings, and lifecycle: `src/controllers/workspaceController.js`
- Canonical runtime subscription/selection: `src/controllers/sessionSubscriptionController.js`
- Automation API/state/polling: `src/services/automationsApi.js` and
  `src/controllers/automationsController.js`
- API client: `src/services/api.js`
- React root and shell: `src/App.jsx`, `src/components/layout/`,
  `src/components/drawers/`, and `src/components/workspaces/`
- Lifecycle workflows: `src/workflows/sessionLifecycle.js`
- Account/connection workflows: `src/workflows/piAuth.js`,
  `src/workflows/mcpServers.js`, `src/workflows/googleWorkspace.js`, and
  `src/workflows/githubConnection.js`
- Component inventory: [UI components](./ui-components.md)
- Bundle measurement and lazy-boundary rationale: [Frontend bundle analysis](./frontend-bundle-analysis.md)

## Current behavior

`src/main.js` initializes Firebase Auth, creates the API client, maintains the
store facade, subscribes to workspace sessions, and passes grouped handlers to
React. The subscription resolves the workspace's canonical runtime; access URLs
are loaded by that runtime surface. Workspace lifecycle actions are
server-authoritative and use the shared pending-operation boundary.

On the first authenticated refresh, `src/utils/userTimezone.js` initializes a
missing profile timezone from the browser's IANA timezone (falling back to
`UTC`) through `PATCH /api/me`. Existing saved timezones are never overwritten;
the schedule preview API remains server-authoritative.

The signed-in shell has no left drawer. Its top navigation contains workspace
Play/Pause lifecycle control beside the workspace selector, followed by the
selected canonical cloud runtime's live CPU and memory meters, then
marked-runtime Agent and Logs icons, workspace Automations, and compact actions for Pi auth, generic
environment keys, workspace MCP servers, and Google Workspace, plus an avatar
icon for the user menu. At tablet and phone widths the shell becomes a two-row
header: brand/avatar/More on the first row and a shrinkable workspace selector
plus lifecycle control on the second. Secondary workspace, connection,
documentation, and marked-runtime actions are available from the keyboard-accessible
labeled More menu. The meters remain mounted across Agent, Chrome, Logs,
profile, and admin surfaces; they are read-only and show unavailable or
reconnecting state instead of stale readings. Google Workspace account management opens in a modal from its topbar
icon. Marked runtimes also show a compact **Keep running** switch in the top
navigation; its help popover summarizes the stored idle timeout, and changing
it persists the explicit Long-running policy through
`setSessionLongRunningState`. The shell no longer reserves either sidebar column. GitHub
account/repository connection controls remain in the profile and workspace
creation flows.

Workspace **Automations** is a lazy, workspace-scoped surface opened from the
topbar or responsive More menu. Opening it never starts a runner. The panel owns
definition selection/editing, storage preparation status, max-concurrency edits,
enable/disable, Run now, delete confirmation, and links from active/queued run
reasons to global history. Storage readiness gates enabling and execution while
still allowing disabled workflow drafts to be saved; preparation never stops the
main workspace automatically. The panel delegates requests and revision fencing
to `automationsController` and returns to the workspace surface without changing
the selected runtime.

New workspaces are marked `agentUiVersion: "pi-web-ui-v1"`. New sessions are
server-selected `pi-chrome` sessions. A marked running session renders
`ManagedAgentSurface` as the borderless, full-height center surface. Agent and
Logs are icon actions in the top navigation; Logs opens an owner-scoped modal with the
runtime's Cloud Run entries and current recorded error. The managed upstream
header places Chrome beside Chat, Terminal, and Git and uses the bounded
postMessage bridge to ask `PiWebUiCanvas` to select the parent-owned persistent
browser canvas. The managed header omits the upstream name/logo but retains
release/version controls and the repository link. Embedded Settings also shows
the upstream UI-plugin catalog and its add/install/update/remove controls in
managed sessions. These exposed update controls are not yet a durable managed
runtime updater: issue #356 still owns package/theme management and replacement
of the image-owned Pi and pi-web-ui artifacts. Preview is not a workspace navigation
surface. The embedded Agent iframe communicates through the signed `/agent/`
gateway and the same exact-origin bridge. Persistent Chrome keeps its signed
access URL. A shell iframe remains
available as a separate terminal surface; historical SSH sessions retain only
their compatibility terminal and port-forward behavior. The managed agent
canvas does not reserve a separate row for runtime-lifetime controls.

The managed center surface owns the full available shell width and height instead of applying
the legacy terminal canvas viewport cap. Its iframe and intermediate wrappers
must preserve a `min-height: 0` / `height: 100%` chain so the upstream UI fills
the desktop viewport without exposing the canvas background below it. The
outer app uses the dynamic viewport unit when supported, and narrow layouts
retain a bounded minimum managed-surface height while the top navigation stacks.
Managed-agent embedding remains edge-to-edge at narrow widths; stopped and
unsupported historical runtimes use compact status cards rather than oversized
empty canvases.

The embedded Agent bridge sends access only for the child readiness handshake or
when the signed access URL actually changes. Listener re-registration, parent
callback identity changes, and access-renewed acknowledgements must not resend
an unchanged URL or trigger a reconnect; genuine expiry/renewal still refreshes
the scoped cookie and follows the upstream socket renewal protocol.

Unmarked historical sessions remain readable and terminal-first, but they do not expose a second
Mapache Chat, Goals, file browser/editor, Git manager, model editor, package
manager, skills manager, subagent manager, or extensions panel. Files, Git,
model selection, skills, extensions, subagents, and native Goals belong to the
embedded upstream application when that application is available.

The landing, admin, profile, modal-stack, and runtime Logs surfaces are lazy-loaded because they are route- or action-specific. The workspace/session path remains eager so terminal and stateful Agent/Chrome canvases can mount without an extra feature request. Bundle measurements and the warning rationale are recorded in [Frontend bundle analysis](./frontend-bundle-analysis.md).

`Topbar` owns the entry points for `PiAuthManageModal`,
`GenericEnvironmentModal`, `McpServersModal`, and
`GoogleWorkspaceManageModal`. `PiAuthManageModal` manages only saved
credential selection and entry CRUD. It does not edit model files or expose
provider secrets. MCP and Google controls remain Mapache-owned because they
configure external connections and token materialization rather than upstream
agent preferences.

`AppShell` owns one `useSessionAccessUrls` and one `useResourceMetrics` instance
for the selected workspace's canonical non-SSH runtime. The signed terminal
access URL derives the authenticated `/metrics` socket URL; changing workspace,
session, or signed URL tears down the prior socket and ignores late events.
Metrics are enabled only for running runtimes and do not attach to the PTY or
update activity. `loadSelectedSessionAccess` in `src/main.js` remains narrow and
is keyed by the workspace's canonical runtime. Workspace Play/Pause delegates to
the retained session lifecycle API internally; users do not select, create,
rename, resize, restart, stop, or delete sibling sessions from the Mapache shell. Compute size
is edited from the workspace edit modal and stored on the workspace. The API
resize call also recovers marked runtimes in `provision_failed`, `update_failed`,
or `stop_failed` when resource settings are saved, even if their recorded size
already matches: saved resources may not yet match Cloud Run. The controller
captures the resize decision before the workspace save can update subscriptions.
Stopped runtimes only save the size for their next start. The API
client retains session-addressed lifecycle/access calls for runtime plumbing
and compatibility, alongside workspace, credentials, MCP, Google, GitHub
connector, and admin operations.

Resize saves close after the API acknowledges the queued operation. The existing
session subscription follows `resizeOperationState`; queued/running operations
show **Resizing** and disable the workspace lifecycle button. Terminal failure
shows `resizeOperationError`, and successful completion restores the normal
runtime status. The browser does not hold a request open for shutdown/startup.

Automation definitions, settings, storage preparation, schedule preview, manual
enqueue, owner-wide history, run events, stop, cancel, and restart use the
dedicated `automationsApi` facade over the shared HTTP client. The controller
stores workspace-scoped definitions and revision state, storage readiness,
concurrency settings, history filters/cursors, the selected run, and bounded
event pages in `state.automations`. Each response is fenced by user, selected
workspace, and controller epoch before it can mutate state. Manual run/restart
actions retain one `Idempotency-Key` across a failed retry and rotate it after
success; revision conflicts refresh the definition and leave a visible conflict
marker. Active/queued history polls every five seconds only while the document
is visible, and no Firestore history listener is created. Pending-run and
main-paused responses retain their server-provided run IDs for UI links.

The automation editor is a controlled component owned by the automation workflow.
`AutomationEditor` keeps edits, expected revisions, and save/error retention in the
parent controller; `ScheduleControls` converts daily and weekly selections to
canonical numeric five-field cron while preserving arbitrary advanced expressions.
Preview requests are debounced and fenced so an older response cannot replace a
newer schedule. New definitions use the saved profile timezone (or the browser
timezone during profile bootstrap); editing always preserves the stored timezone.
The form intentionally remains mountable without workspace navigation: the
automation management surface owns routing and placement in a later slice.

Global run history is a separate controller scope from the selected-workspace
automation slice. `RunHistoryPage` can load owner-wide runs when no workspace is
selected, preserving filters and cursor state while `RunDetailsPanel` loads a
single snapshot and paged archived events. History actions use the existing
server-owned Stop/Restart endpoints; archived prompt and transcript content is
rendered through `react-markdown` without raw HTML or a live runner session.
Entering history disables runtime access URL and resource-metrics attachment so
the page cannot boot or reconnect the main runtime merely to inspect a past run.

## Invariants

- The browser cannot select an image or runtime UI version; Functions resolves
  the curated runner.
- Agent execution state comes from the server/runtime status, never from iframe
  presence or rendered terminal text.
- Parent UI code does not implement the upstream chat protocol or duplicate
  upstream files/Git/models/skills/extensions/subagents/Goals behavior.
- Account credentials and external connection bindings stay in Mapache-owned
  workflows; secret values are not rendered into the agent iframe by Mapache.
- New frontend behavior belongs in focused controllers, workflows, or
  components rather than expanding `src/main.js`.

## Verification

- `npm run test:frontend`
- `npm run build`
- `npm run docs:check`

## Related docs

- [UI components](./ui-components.md)
- [Frontend bundle analysis](./frontend-bundle-analysis.md)
- [Backend API architecture](./backend-api-architecture.md)
- [Runner harnesses](./runner-harnesses.md)
- [Runtime containers](./runtime-containers.md)
- [Deployment](./deployment.md)

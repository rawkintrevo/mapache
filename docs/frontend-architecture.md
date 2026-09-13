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
- API client: `src/services/api.js`
- React root and shell: `src/App.jsx`, `src/components/layout/`,
  `src/components/drawers/`, and `src/components/workspaces/`
- Lifecycle workflows: `src/workflows/sessionLifecycle.js`
- Account/connection workflows: `src/workflows/piAuth.js`,
  `src/workflows/mcpServers.js`, `src/workflows/googleWorkspace.js`, and
  `src/workflows/githubConnection.js`
- Component inventory: [UI components](./ui-components.md)

## Current behavior

`src/main.js` initializes Firebase Auth, creates the API client, maintains the
store facade, subscribes to workspace sessions, and passes grouped handlers to
React. The subscription resolves the workspace's canonical runtime; access URLs
are loaded by that runtime surface. Workspace lifecycle actions are
server-authoritative and use the shared pending-operation boundary.

The signed-in shell has no left drawer. Its top navigation contains workspace
Play/Pause lifecycle control beside the workspace selector, marked-runtime
Agent and Logs icons, compact actions for Pi auth, generic environment keys,
workspace MCP servers, and Google Workspace, plus an avatar icon for the user
menu. Google Workspace account management opens in a modal from its topbar
icon; the shell no longer reserves either sidebar column. GitHub
account/repository connection controls remain in the profile and workspace
creation flows.

New workspaces are marked `agentUiVersion: "pi-web-ui-v1"`. New sessions are
server-selected `pi-chrome` sessions. A marked running session renders
`ManagedAgentSurface` as the borderless, full-height center surface. Agent and
Logs are icon actions in the top navigation; Logs opens an owner-scoped modal with the
runtime's Cloud Run entries and current recorded error. The managed upstream
header places Chrome beside Chat, Terminal, and Git and uses the bounded
postMessage bridge to ask `PiWebUiCanvas` to select the parent-owned persistent
browser canvas. That managed header also omits the upstream name/logo, release
version controls, and repository link. Preview is not a workspace navigation
surface. The embedded Agent iframe communicates through the signed `/agent/`
gateway and the same exact-origin bridge. Persistent Chrome keeps its signed
access URL. A shell iframe remains
available as a separate terminal surface; historical SSH sessions retain only
their compatibility terminal and port-forward behavior.

The managed center surface owns the full available shell width and height instead of applying
the legacy terminal canvas viewport cap. Its iframe and intermediate wrappers
must preserve a `min-height: 0` / `height: 100%` chain so the upstream UI fills
the desktop viewport without exposing the canvas background below it. The
outer app uses the dynamic viewport unit when supported, and narrow layouts
retain a bounded minimum managed-surface height while the top navigation stacks.

Unmarked historical sessions remain readable and terminal-first, but they do not expose a second
Mapache Chat, Goals, file browser/editor, Git manager, model editor, package
manager, skills manager, subagent manager, or extensions panel. Files, Git,
model selection, skills, extensions, subagents, and native Goals belong to the
embedded upstream application when that application is available.

`Topbar` owns the entry points for `PiAuthManageModal`,
`GenericEnvironmentModal`, `McpServersModal`, and
`GoogleWorkspaceManageModal`. `PiAuthManageModal` manages only saved
credential selection and entry CRUD. It does not edit model files or expose
provider secrets. MCP and Google controls remain Mapache-owned because they
configure external connections and token materialization rather than upstream
agent preferences.

`loadSelectedSessionAccess` in `src/main.js` remains narrow and is keyed by the
workspace's canonical runtime. Workspace Play/Pause delegates to the retained
session lifecycle API internally; users do not select, create, rename, resize,
restart, stop, or delete sibling sessions from the Mapache shell. Compute size
is edited from the workspace edit modal and stored on the workspace. The API
client retains session-addressed lifecycle/access calls for runtime plumbing
and compatibility, alongside workspace, credentials, MCP, Google, GitHub
connector, and admin operations.

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
- [Backend API architecture](./backend-api-architecture.md)
- [Runner harnesses](./runner-harnesses.md)
- [Runtime containers](./runtime-containers.md)
- [Deployment](./deployment.md)

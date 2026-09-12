# Frontend Architecture

This page owns the current frontend state, rendering, and workflow boundaries.
The embedded upstream application is the agent surface for marked workspaces;
Mapache owns the surrounding workspace/session shell and account connections.

## Canonical owners

- Startup and orchestration: `src/main.js`
- App state and reducer boundary: `src/state/appStore.js` and
  `src/state/initialState.js`
- Workspace selection and CRUD: `src/controllers/workspaceController.js`
- Session subscription/selection: `src/controllers/sessionSubscriptionController.js`
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
React. Selection changes load only retained SSH-forward state; access URLs are
loaded by the selected session surface. Workspace and session lifecycle actions
are server-authoritative and use the shared pending-operation boundary.

The signed-in shell has a Sessions drawer, workspace/session lifecycle controls,
the workspace/session view, an account/profile surface, and a retained
Mapache-owned inspector. The inspector contains Authentication Center, generic
environment keys, MCP configuration, and Google Workspace connections. GitHub
account/repository connection controls remain in the profile and workspace
creation flows.

New workspaces are marked `agentUiVersion: "pi-web-ui-v1"`. New sessions are
server-selected `pi-chrome` sessions. A marked running session renders
`ManagedAgentSurface`, whose sibling tabs are Agent, Persistent Chrome, and
Preview; resource metrics are separate read-only status. The embedded Agent
iframe communicates through the signed `/agent/` gateway and a bounded
postMessage bridge. Persistent Chrome and Preview keep their existing signed
access URLs. A shell iframe remains available as a separate terminal surface;
historical SSH sessions retain only their compatibility terminal and
port-forward behavior.

Unmarked historical sessions remain readable, but they do not expose a second
Mapache Chat, Goals, file browser/editor, Git manager, model editor, package
manager, skills manager, subagent manager, or extensions panel. Files, Git,
model selection, skills, extensions, subagents, and native Goals belong to the
embedded upstream application when that application is available.

`PiAuthManageModal` manages only saved credential selection and entry CRUD. It
does not edit model files or expose provider secrets. MCP and Google controls
remain Mapache-owned because they configure external connections and token
materialization rather than upstream agent preferences.

`loadSelectedSessionAccess` in `src/main.js` is intentionally narrow: it refreshes
retained SSH-forward state for a selected historical SSH session. There is no
generic panel fan-out for retired Mapache controls. The API client likewise
contains only workspace/session lifecycle, signed access, retained SSH
forwarding, credentials, MCP, Google, GitHub connector, and admin operations.

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

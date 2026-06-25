# Frontend Architecture

## Purpose

This page owns the current frontend architecture: state ownership, React rendering boundaries, workflow modules, and UI/component routing.

## Read When

Read this before changing frontend startup, workspace/session state, modals, drawers, terminal/preview placement, Git controls, Pi panels, file workflows, or shared app styling.

## Canonical Owner

- Startup and global state: `src/main.js`
- React root: `src/App.jsx`
- Shell and layout: `src/components/layout/`
- Domain workflows: `src/workflows/`
- UI controllers: `src/controllers/`
- API client: `src/services/api.js`
- Component inventory: [ui-components.md](./ui-components.md)

## Current Behavior

The frontend uses Vite and React. `src/main.js` initializes Firebase/Auth, owns the top-level app state, coordinates selected workspace/session subscriptions, and passes grouped handlers into React. `src/App.jsx` chooses between the public landing page, fatal error surface, and signed-in app shell.

The signed-in shell is componentized under `src/components/`. `AppShell` owns the outer app wrapper, drawers, workspace panel, profile page, right inspector drawer, and modal stack. The Profile page includes account details, runner usage, and account-level GitHub connector controls for status, OAuth restart/connect, repository refresh, installation settings, and soft disconnect. The selected-session experience is terminal-first; runner-dependent panels reset while a selected session is provisioning, stopped, failed, or missing `serviceUrl`.

The workspace modal supports Blank, GitHub, and Dev machine sources. Dev machine creation collects host, port, username, initial directory, SSH authentication mode, private key, optional signed user certificate, and optional known-hosts content. The session modal derives its session target from the selected workspace instead of exposing a session-type chooser: Blank and GitHub workspaces create Cloud runner sessions with an image selector, while Dev machine workspaces create SSH sessions using the workspace target configuration. When the selected session is SSH-backed, the left file drawer loads session-scoped SSH file data instead of workspace Cloud Storage files, the session detail panel shows authenticated localhost port-forward controls, and selected-session startup skips Git status, Pi package, and workspace skill polling because those runner routes are only supported by local Cloud runner harnesses.

Preview-capable sessions show Preview, Share Preview, and Publish actions in `SessionDetail`. Share Preview calls the authenticated API to export the static build and then displays a copyable public preview URL. Publish is intentionally informational in V1 and directs users to contact `trevor@ata.systems`; it must not imply a production deploy happened.

The left drawer exposes session creation only from the Sessions section header for the selected workspace; workspace rows do not duplicate that action. Workspace rows and the selected workspace header show a type tag from `src/components/workspaces/workspaceSourceSummary.js` (`Blank`, `GitHub`, or `Dev machine`) instead of exposing implementation-flavored storage/session prefixes in the primary summary. The left drawer user menu shows an Admin item only when the current profile includes `isAdmin: true`. The Admin page lives in `src/components/admin/AdminPage.jsx` and reads paginated user summaries through `src/services/api.js`; `src/main.js` owns the admin page cursor stack, refresh, and whitelist toggle handlers.

Workflow modules under `src/workflows/` own cohesive API/state sequences such as session lifecycle, GitHub connection and repository refresh, Git/PR operations, Pi auth, Pi packages, workspace skills, workspace subagents, and workspace file/editor actions. Controller modules under `src/controllers/` own drawer toggles, modal visibility, file tree/editor handlers, and right-panel handlers so `src/main.js` does not keep growing flat callback lists.

Workspace file browsing is lazy. `src/workflows/workspaceFiles.js` loads the root directory first, tracks loaded directories in `state.workspaceFileLoadedDirs`, and fetches a directory's immediate children only when `WorkspaceFileTree` expands that folder. The workflow supports both Cloud Storage-backed workspaces and selected SSH sessions through the same directory-scoped API shape.

The right inspector also owns workspace-scoped MCP server management through `state.mcpServers`. The MCP panel edits the selected workspace's shared MCP config, not a single session; newly created sessions receive the config snapshot automatically and active sessions pick up edits after restart. Harness capability routing is centralized in `src/utils/sessionHarnesses.js` so panels do not guess behavior from image prefixes. The Skills inspector uses harness-neutral state under `state.workspaceSkills` and chooses the active workspace skill root from the selected session's harness metadata. Pi sessions write `.pi/skills/**`; Codex sessions write `.agents/skills/**`; shell and SSH sessions show an unsupported-state message instead of the edit form. The Subagents inspector mirrors that model under `state.workspaceSubagents`, writing `.pi/agents/*.md` for Pi and `.codex/agents/*.toml` for Codex.

## Styling

Global CSS enters through `src/styles.css`, which imports `src/styles/tokens.css`, `src/styles/base.css`, `src/styles/primitives.css`, and `src/styles/layout.css`. Component-specific selectors live beside their React components as plain CSS sidecars when practical. See [css-decomposition.md](./css-decomposition.md).

## Invariants

- Keep terminal-first selected-session behavior.
- Keep `src/main.js` as the state orchestration point until a touched area is deliberately extracted.
- Add new feature logic to focused controllers, workflows, services, or components instead of expanding monoliths.
- Update [ui-components.md](./ui-components.md) when adding significant components.
- Keep `community/` out of frontend app refactors unless the task explicitly targets user-facing community docs.

## Verification

- `npm run test:frontend`
- `npm run build` for frontend-facing changes when feasible.
- `npm run docs:check` after docs edits.

## Last Verified Assumptions

- 2026-06-17: Source tree contains React component sidecars, controller modules, workflow modules, and global style layers matching this page.

## Related Docs

- [App overview](./app-overview.md)
- [UI components](./ui-components.md)
- [Runner harnesses](./runner-harnesses.md)
- [Style guide](./STYLE_GUIDE.md)
- [CSS decomposition](./css-decomposition.md)
- [SSH-backed sessions guide](./guides/ssh-backed-sessions.md)

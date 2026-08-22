# Frontend Architecture

## Purpose

This page owns the current frontend architecture: state ownership, React rendering boundaries, workflow modules, and UI/component routing.

## Read When

Read this before changing frontend startup, workspace/session state, modals, drawers, terminal/preview placement, Git controls, Pi panels, file workflows, or shared app styling.

## Canonical Owner

- Startup and global state: `src/main.js`
- Workspace refresh, selection, creation, and deletion: `src/controllers/workspaceController.js`
- Session subscription and selection repair: `src/controllers/sessionSubscriptionController.js`
- React root: `src/App.jsx`
- Shell and layout: `src/components/layout/`
- Domain workflows: `src/workflows/`
- UI controllers: `src/controllers/`
- API client: `src/services/api.js`
- Component inventory: [ui-components.md](./ui-components.md)

## Current Behavior

The frontend uses Vite and React. `src/main.js` initializes Firebase/Auth, owns the top-level app state, coordinates selected workspace/session subscriptions, and passes grouped handlers into React. `src/App.jsx` chooses between the public landing page, fatal error surface, and signed-in app shell.

Top-level identity, selection, page, pending-operation, and error transitions go through the reducer-backed store in `src/state/appStore.js`. Named pending operations live in `state.pendingOperations` with reference counts and user-facing messages, so overlapping and nested `runBusy` calls can finish independently. The store keeps a stable state facade while the remaining domain fields are migrated incrementally, so existing workflow modules can continue receiving their state reference. Reducers return immutable next-state objects, and store subscribers are available for future render extraction.

The signed-in shell is componentized under `src/components/`. `AppShell` owns the outer app wrapper, drawers, workspace panel, profile page, right inspector drawer, and modal stack. Admin, profile, and modal surfaces are deferred with `React.lazy`; the terminal-first workspace shell renders independently, with `LazySurfaceFallback` covering a deferred surface while its chunk loads. The Profile page includes account details, runner usage, and account-level GitHub connector controls for status, OAuth restart/connect, repository refresh, installation settings, and soft disconnect. The selected-session experience is terminal-first; runner-dependent panels reset while a selected session is provisioning, stopped, failed, or missing `serviceUrl`. Session status presentation distinguishes queued provisioning from active provisioning, and retryable provisioning failures expose one retry action that is disabled while an operation is pending.

The workspace modal supports Blank, GitHub, and Dev machine sources. Dev machine creation collects host, port, username, initial directory, SSH authentication mode, private key, optional signed user certificate, and optional known-hosts content. The session modal derives its session target from the selected workspace instead of exposing a session-type chooser: Blank and GitHub workspaces create Cloud runner sessions with an image selector, while Dev machine workspaces create SSH sessions using the workspace target configuration. When the selected session is SSH-backed, the left file drawer loads session-scoped SSH file data instead of workspace Cloud Storage files, the session detail panel shows authenticated localhost port-forward controls, and selected-session startup skips Git status, Pi package, and workspace skill polling because those runner routes are only supported by local Cloud runner harnesses.

Preview-capable sessions show Preview, Share Preview, and Publish actions in `SessionDetail`. Chrome-capable sessions show a capability-gated `Persistent Chrome` tab rendered by `src/components/sessions/BrowserCanvas.jsx`; its iframe uses the signed `browserUrl` and its toolbar opens the same authenticated browser surface in a new tab. Share Preview calls the authenticated API to export the static build and then displays a copyable public preview URL. Publish is intentionally informational in V1 and directs users to contact `trevor@ata.systems`; it must not imply a production deploy happened.

The top bar owns workspace selection through a compact dropdown, with adjacent create and delete actions. The left drawer starts with workspace-scoped Files and Sessions sections, exposes session creation only from the Sessions section header for the selected workspace, and gives every session row an edit action. `SessionEditModal` owns session renaming plus the existing resource preset and advanced CPU/memory resize controls; resource sizing is not repeated below the selected terminal. The selected workspace header shows a type tag from `src/components/workspaces/workspaceSourceSummary.js` (`Blank`, `GitHub`, or `Dev machine`) instead of exposing implementation-flavored storage/session prefixes in the primary summary. The left drawer user menu shows an Admin item only when the current profile includes `isAdmin: true`. The Admin page lives in `src/components/admin/AdminPage.jsx` and reads paginated user summaries through `src/services/api.js`; `src/main.js` owns the admin page cursor stack, refresh, and whitelist toggle handlers.

Workflow modules under `src/workflows/` own cohesive API/state sequences such as session lifecycle, GitHub connection and repository refresh, Git/PR operations, Pi auth, Pi packages, workspace skills, workspace subagents, and workspace file/editor actions. Controller modules under `src/controllers/` own drawer toggles, modal visibility, file tree/editor handlers, and right-panel handlers so `src/main.js` does not keep growing flat callback lists.

Workspace file browsing is lazy. `src/workflows/workspaceFiles.js` loads the root directory first, tracks loaded directories in `state.workspaceFileLoadedDirs`, and fetches a directory's immediate children only when `WorkspaceFileTree` expands that folder. The workflow supports both Cloud Storage-backed workspaces and selected SSH sessions through the same directory-scoped API shape.

Selected-session panel loads capture the current workspace/session identity through `src/utils/sessionRequest.js`. Git, Pi packages, skills, subagents, workspace files, and SSH forwarding ignore responses from requests that belong to an older selection. Independent panel requests launch concurrently through `src/workflows/selectedSessionPanels.js`, while capability-gated panels retain their existing reset and error states.

The Files section action trigger opens an accessible popover with upload, create-file, and create-directory actions. New Cloud Storage-backed files and directory markers are created through the workspace API in the active directory (the selected file's parent or the last expanded directory), then synced and reloaded; new files are opened in the editor automatically. SSH-backed file scopes keep creation disabled and surface the existing unsupported-action message for uploads.

`FileEditorDialog` keeps text editing as the default view for every file. Files ending in `.md` or `.markdown` additionally expose Edit and Preview tabs; Preview renders the dialog's current content, including unsaved edits, with GitHub Flavored Markdown support while leaving the existing Save action available. Raw HTML is not rendered by the Markdown preview.

The right inspector uses `InspectorResourcePanel` and `InspectorResourceRow` in `src/components/inspector/InspectorResourcePanel.jsx` as the shared resource-management interface. The common layer owns section action order, status messaging, accessibility labels, and row edit/delete treatment; refresh and exceptional bulk actions remain compact header controls. Each domain panel supplies its own resource mapping, capability gates, and exceptional actions. `InspectorEditorModal` provides the shared editor dialog shell for modal-backed create/edit forms. Authentication Center is intentionally compact in the inspector: it exposes session-scoped auth management and generic-environment management actions without listing credentials or showing an add-provider action. `PiAuthManageModal` owns provider creation, selection, edit, and delete controls. The Skills inspector follows the same compact pattern: `SkillsPanel` launches `WorkspaceSkillModal`, which owns skill creation plus the checked discovered-skill inventory and writable-root edit/delete actions. Skill state remains harness-neutral under `state.workspaceSkills`; Pi writes `.pi/skills/**`, Codex writes `.agents/skills/**`, and the runner augments the modal inventory with recursive shared and user-local discovery roots. Shell and SSH sessions show an unsupported-state message. The right inspector also owns workspace-scoped MCP server management through `state.mcpServers`. The MCP panel edits the selected workspace's shared MCP config, not a single session; newly created sessions receive the config snapshot automatically and active sessions pick up edits after restart. Harness capability routing is centralized in `src/utils/sessionHarnesses.js` so panels do not guess behavior from image prefixes. The Subagents inspector mirrors the harness-neutral state model under `state.workspaceSubagents`, writing `.pi/agents/*.md` for Pi and `.codex/agents/*.toml` for Codex.

The Google Workspace inspector uses `state.googleWorkspace` and `src/controllers/googleWorkspaceController.js` to render only safe saved-account summaries. A checked account is bound to the selected workspace and an unplugged account is unbound; the row toggle removes or restores that workspace binding with the account's authorized services. Add and edit actions open `GoogleWorkspaceModal`, which owns Workspace service selection, read-only/read-write access, and starting OAuth. OAuth completion refreshes the account list through a popup-close watcher. Account deletion warns with the number of affected workspace bindings, while binding changes apply only to the selected workspace and take effect for newly created or restarted sessions.

The Authentication Center also manages generic environment keys through the separate `src/components/modals/GenericEnvironmentModal.jsx` surface and the Pi auth workflow. Names and labels are visible, but values are write-only after save. Saving a key while a session is selected automatically adds it to that session, and each registered-key row exposes a checkbox for changing the active session selection. Workspace and session creation forms can also select saved key IDs. Generic environment keys do not appear in the Pi auth management modal; saving provider selections preserves the session's existing environment-key selection. Applying a changed environment selection requires restart or reprovisioning.

Running Pi sessions expose a Models action beside the session controls. `PiModelsModal` loads the live authenticated catalog through the Functions proxy and runner `GET /models` route, supports search and bulk selection, and saves the ordered model IDs through `PUT /models`. Saving updates both Pi's `enabledModels` setting and the session document's `piScopedModels`; the user restarts Pi inside the terminal to apply the cycle list to an already-running Pi process.

Cloud runner creation and resize use the shared resource catalog in `functions/sessionResourceCatalog.json`, imported by `src/utils/sessionResources.js`. `SessionResourceSelector` renders the priced `Small`, `Medium`, and `Large` presets as the primary control and keeps CPU/memory selectors under an accessible `Advanced settings` disclosure. Presets and advanced edits update the same normalized CPU/memory state; an exact preset is labeled by name and every other supported pair is labeled `Custom`. `SessionModal` uses the Small mapping by default for Cloud sessions, while SSH-backed creation retains its existing explicit CPU/memory controls. `SessionEditModal` reuses the same controls for existing sessions, submitting a resize only when CPU or memory changed and a rename only when the trimmed name changed. `SessionList` and `DrawerSessionList` summarize matched allocations with the preset label and show `Custom` for legacy or non-preset pairs.

Session rows show runner image freshness independently from lifecycle status. The backend persists the deployed Cloud Run image digest and periodically compares it with the current Artifact Registry digest for the session's selected `imageKey`, exposing `latest`, `stale`, or `unknown`. Stale running sessions show a yellow freshness indicator and a restart action that explicitly explains it will pick up the latest container; stopped, provisioning, legacy, or lookup-failure states remain neutral/unknown.

The catalog currently maps Small to `1 vCPU / 2 GiB`, Medium to `2 vCPU / 4 GiB`, and Large to `4 vCPU / 8 GiB`. Displayed prices are compute-only hourly estimates from the catalog's us-central1 rate metadata; they exclude free tier, discounts, network, storage, build, and other charges. Existing CPU/memory values remain the submitted API fields, so the UI does not require or persist a size key.

## Styling

Global CSS enters through `src/styles.css`, which imports `src/styles/tokens.css`, `src/styles/base.css`, `src/styles/primitives.css`, and `src/styles/layout.css`. Component-specific selectors live beside their React components as plain CSS sidecars when practical. See [css-decomposition.md](./css-decomposition.md).

## Invariants

- Keep terminal-first selected-session behavior.
- Keep `src/main.js` as the state orchestration point until a touched area is deliberately extracted.
- Add new feature logic to focused controllers, workflows, services, or components instead of expanding monoliths.
- Keep the shared session resource catalog and pricing helpers authoritative; do not duplicate preset or rate literals in session components.
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

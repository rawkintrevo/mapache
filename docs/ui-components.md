# UI Components Index

## Purpose

This page maps significant React UI components to file locations and responsibilities.

## Read When

Read this before adding, moving, or substantially changing UI components.

This document serves as an index for significant UI components in the application, helping maintainers locate functionality and understand component purpose.

| Component | File Path | Purpose |
| :--- | :--- | :--- |
| `App` | `src/App.jsx` | React root component that routes between the `/` landing page, fatal error, and the signed-in `/app` shell. |
| `LandingPageScreen` | `src/components/auth/LandingPageScreen.jsx` | React landing page for public or signed-out users, with a sign-in action or app-open action for signed-in users at `/`. |
| `Button` | `src/components/common/Button.jsx` | Shared button component for semantic variants, icon sizing, and icon-only tooltips. |
| `FatalError` | `src/components/common/FatalError.jsx` | React configuration/startup error screen. |
| `AppShell` | `src/components/layout/AppShell.jsx` | React signed-in shell that owns the app wrapper, top bar, grid layout, drawers, workspace panel, and modal stack. |
| `Topbar` | `src/components/layout/Topbar.jsx` | React signed-in header with brand, user label, refresh, and sign-out controls. |
| `GlobalActionIndicator` | `src/components/layout/GlobalActionIndicator.jsx` | Shell-level live status indicator shown while global `state.busy` actions are running. |
| `LeftDrawer` | `src/components/drawers/LeftDrawer.jsx` | React left navigation drawer for workspaces, files, sessions, and the pinned user menu. |
| `DrawerList` | `src/components/drawers/DrawerList.jsx` | Shared drawer row/list primitives for workspace, session, auth provider, package, extension, and future skill rows. |
| `DrawerSection` | `src/components/drawers/DrawerSection.jsx` | Reusable collapsible drawer section component. |
| `WorkspaceDrawerList` | `src/components/drawers/WorkspaceDrawerList.jsx` | React workspace list used by the left drawer. |
| `DrawerSessionList` | `src/components/drawers/DrawerSessionList.jsx` | React session list used by the left drawer, including stop/delete actions. |
| `WorkspaceFileTree` | `src/components/files/WorkspaceFileTree.jsx` | React expandable file tree used by the left drawer for workspace storage files or selected SSH session files. |
| `UserMenu` | `src/components/drawers/UserMenu.jsx` | Pinned left-drawer user avatar/profile popover with profile, refresh, and sign-out actions. |
| `AdminPage` | `src/components/admin/AdminPage.jsx` | Admin-only React page for paginated user listing, allowlist toggles, per-user cost display, and reserved user type selection. |
| `ProfilePage` | `src/components/profile/ProfilePage.jsx` | User profile page showing Firebase profile details, GitHub connector controls, runner usage, and account actions. |
| `RightDrawer` | `src/components/inspector/RightDrawer.jsx` | React right inspector drawer. |
| `AuthCenterPanel` | `src/components/inspector/AuthCenterPanel.jsx` | React Authentication Center panel showing user-scoped Pi auth providers. |
| `McpServersPanel` | `src/components/inspector/McpServersPanel.jsx` | React MCP server management panel for selected-workspace MCP configuration applied to new and restarted Pi/Codex sessions. |
| `SkillsPanel` | `src/components/inspector/SkillsPanel.jsx` | React Skills panel for workspace-local Markdown skills, switching between Pi `.pi/skills` and Codex `.agents/skills` based on the selected session harness. |
| `ExtensionsPanel` | `src/components/inspector/ExtensionsPanel.jsx` | React Extensions panel for workspace-local Pi packages. |
| `PackageInstallForm` | `src/components/inspector/PackageInstallForm.jsx` | React form for installing Pi packages into the active workspace. |
| `PackageRow` | `src/components/inspector/PackageRow.jsx` | React row for installed, user-scoped, and known Pi packages. |
| `WorkspacePanel` | `src/components/workspaces/WorkspacePanel.jsx` | React main workspace panel; renders terminal-first session detail or workspace overview/session list. |
| `WorkspaceHeader` | `src/components/workspaces/WorkspaceHeader.jsx` | React workspace title and source summary. |
| `SessionDetail` | `src/components/sessions/SessionDetail.jsx` | React terminal iframe, capability-gated preview canvas, resize controls, restart controls, SSH port-forward controls, and Git status placement for the selected session. |
| `GitStatusPanel` | `src/components/sessions/GitStatusPanel.jsx` | React GitHub-session panel under the terminal for Git status, pull, stage/unstage, commit, push, and pull request actions. |
| `SessionList` | `src/components/sessions/SessionList.jsx` | React session list for the selected workspace. |
| `SessionStatusSummary` | `src/components/sessions/SessionStatusSummary.jsx` | Shared session-row accessory that renders the accessible status light tooltip and hyphen-split runner tags for both session list variants. |
| `ModalStack` | `src/components/modals/ModalStack.jsx` | React modal coordinator for all app modals. |
| `ModalBackdrop` | `src/components/modals/ModalBackdrop.jsx` | Shared React modal overlay/backdrop behavior. |
| `AuthModal` | `src/components/modals/AuthModal.jsx` | React modal for adding named authentication provider entries, including API keys and the OpenAI Codex subscription device-code login flow. |
| `PiAuthManageModal` | `src/components/modals/PiAuthManageModal.jsx` | React modal for selecting which saved Pi auth entry per provider is materialized into the active Pi session's `auth.json`. |
| `WorkspaceModal`| `src/components/modals/WorkspaceModal.jsx` | React modal for creating a new blank or GitHub-backed workspace, including the GitHub App connected repository picker, repository URL fallback, and optional branch field. |
| `SessionModal` | `src/components/modals/SessionModal.jsx` | React modal for creating a Cloud runner session or SSH target session. |
| `FileEditorDialog`| `src/components/modals/FileEditorDialog.jsx` | React file editor modal. |
| `PullRequestModal`| `src/components/modals/PullRequestModal.jsx` | React pull request creation modal. |
| `WorkspaceSkillModal` | `src/components/modals/WorkspaceSkillModal.jsx` | React modal for creating and editing workspace-local Markdown skills from the right inspector Skills panel. |

When adding new UI components, please update this index.

## Related Docs

- [Frontend architecture](./frontend-architecture.md)
- [Style guide](./STYLE_GUIDE.md)
- [CSS decomposition](./css-decomposition.md)

# UI Components Index

This document serves as an index for significant UI components in the application, helping maintainers locate functionality and understand component purpose.

| Component | File Path | Purpose |
| :--- | :--- | :--- |
| `App` | `src/App.jsx` | React root component that routes between auth, fatal error, and the signed-in shell. |
| `AuthScreen` | `src/components/auth/AuthScreen.jsx` | React landing page for users who are not logged in. |
| `Button` | `src/components/common/Button.jsx` | Shared button component for semantic variants, icon sizing, and icon-only tooltips. |
| `FatalError` | `src/components/common/FatalError.jsx` | React configuration/startup error screen. |
| `AppShell` | `src/components/layout/AppShell.jsx` | React signed-in shell that owns the app wrapper, top bar, grid layout, drawers, workspace panel, and modal stack. |
| `Topbar` | `src/components/layout/Topbar.jsx` | React signed-in header with brand, user label, refresh, and sign-out controls. |
| `LeftDrawer` | `src/components/drawers/LeftDrawer.jsx` | React left navigation drawer for workspaces, files, sessions, and the pinned user menu. |
| `DrawerList` | `src/components/drawers/DrawerList.jsx` | Shared drawer row/list primitives for workspace, session, auth provider, package, extension, and future skill rows. |
| `DrawerSection` | `src/components/drawers/DrawerSection.jsx` | Reusable collapsible drawer section component. |
| `WorkspaceDrawerList` | `src/components/drawers/WorkspaceDrawerList.jsx` | React workspace list used by the left drawer. |
| `DrawerSessionList` | `src/components/drawers/DrawerSessionList.jsx` | React session list used by the left drawer, including stop/delete actions. |
| `WorkspaceFileTree` | `src/components/files/WorkspaceFileTree.jsx` | React expandable workspace file tree used by the left drawer. |
| `UserMenu` | `src/components/drawers/UserMenu.jsx` | Pinned left-drawer user avatar/profile popover with profile, refresh, and sign-out actions. |
| `ProfilePage` | `src/components/profile/ProfilePage.jsx` | User profile page showing Firebase profile details and account actions. |
| `RightDrawer` | `src/components/inspector/RightDrawer.jsx` | React right inspector drawer. |
| `AuthCenterPanel` | `src/components/inspector/AuthCenterPanel.jsx` | React Authentication Center panel showing user-scoped Pi auth providers. |
| `ExtensionsPanel` | `src/components/inspector/ExtensionsPanel.jsx` | React Extensions panel for workspace-local Pi packages. |
| `PackageInstallForm` | `src/components/inspector/PackageInstallForm.jsx` | React form for installing Pi packages into the active workspace. |
| `PackageRow` | `src/components/inspector/PackageRow.jsx` | React row for installed, user-scoped, and known Pi packages. |
| `WorkspacePanel` | `src/components/workspaces/WorkspacePanel.jsx` | React main workspace panel; renders terminal-first session detail or workspace overview/session list. |
| `WorkspaceHeader` | `src/components/workspaces/WorkspaceHeader.jsx` | React workspace title and source summary. |
| `SessionDetail` | `src/components/sessions/SessionDetail.jsx` | React terminal iframe, resize controls, and restart controls for the selected session. |
| `SessionList` | `src/components/sessions/SessionList.jsx` | React session list for the selected workspace. |
| `ModalStack` | `src/components/modals/ModalStack.jsx` | React modal coordinator for all app modals. |
| `ModalBackdrop` | `src/components/modals/ModalBackdrop.jsx` | Shared React modal overlay/backdrop behavior. |
| `AuthModal` | `src/components/modals/AuthModal.jsx` | React modal for adding authentication providers, including API keys and the OpenAI Codex subscription device-code login flow. |
| `WorkspaceModal`| `src/components/modals/WorkspaceModal.jsx` | React modal for creating a new workspace. |
| `SessionModal` | `src/components/modals/SessionModal.jsx` | React modal for creating a new session. |
| `FileEditorDialog`| `src/components/modals/FileEditorDialog.jsx` | React file editor modal. |
| `PullRequestModal`| `src/components/modals/PullRequestModal.jsx` | React pull request creation modal. |

When adding new UI components, please update this index.

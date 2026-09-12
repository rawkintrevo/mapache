# UI Components Index

This index maps significant React components to their current responsibilities.

| Component | File | Responsibility |
| --- | --- | --- |
| `App` | `src/App.jsx` | Routes landing, fatal-error, and signed-in app states. |
| `AppShell` | `src/components/layout/AppShell.jsx` | Signed-in layout, drawers, workspace panel, and modal stack. |
| `Topbar` | `src/components/layout/Topbar.jsx` | Workspace selection, create/edit/delete, refresh, and documentation links. |
| `LeftDrawer` | `src/components/drawers/LeftDrawer.jsx` | Sessions list and lifecycle actions plus the user menu. |
| `DrawerSessionList` | `src/components/drawers/DrawerSessionList.jsx` | Session rows with select/edit/restart/stop/delete actions. |
| `UserMenu` | `src/components/drawers/UserMenu.jsx` | Profile, admin, refresh, and sign-out actions. |
| `WorkspacePanel` | `src/components/workspaces/WorkspacePanel.jsx` | Workspace header/session list or selected-session detail. |
| `WorkspaceHeader` | `src/components/workspaces/WorkspaceHeader.jsx` | Workspace name and source summary. |
| `SessionDetail` | `src/components/sessions/SessionDetail.jsx` | Terminal-first historical view with Agent/Chrome/Preview and shell surfaces. |
| `ManagedAgentSurface` | `src/components/sessions/ManagedAgentSurface.jsx` | Marked Agent-first view with Agent, Persistent Chrome, Preview, metrics, and lifecycle controls. |
| `PiWebUiCanvas` | `src/components/sessions/PiWebUiCanvas.jsx` | Signed embedded upstream `/agent/` iframe and access renewal bridge. |
| `BrowserCanvas` | `src/components/sessions/BrowserCanvas.jsx` | Signed Persistent Chrome iframe and pop-out action. |
| `ResourceUtilization` | `src/components/sessions/ResourceUtilization.jsx` | Read-only CPU/RAM metrics surface. |
| `SessionRuntimeStatus` | `src/components/sessions/SessionRuntimeStatus.jsx` | Server-reported runtime/checkpoint/lifecycle status and access errors. |
| `SessionList` | `src/components/sessions/SessionList.jsx` | Session list for the selected workspace. |
| `SessionResourceSelector` | `src/components/sessions/SessionResourceSelector.jsx` | Shared priced resource presets and advanced CPU/memory fields. |
| `RightDrawer` | `src/components/inspector/RightDrawer.jsx` | Retained Mapache inspector sections. |
| `AuthCenterPanel` | `src/components/inspector/AuthCenterPanel.jsx` | Saved credential selection and generic environment entry access. |
| `McpServersPanel` | `src/components/inspector/McpServersPanel.jsx` | Workspace MCP configuration. |
| `GoogleWorkspacePanel` | `src/components/inspector/GoogleWorkspacePanel.jsx` | Google connection summaries and workspace bindings. |
| `ModalStack` | `src/components/modals/ModalStack.jsx` | Coordinates retained workspace/session/auth/connection dialogs. |
| `AuthModal` | `src/components/modals/AuthModal.jsx` | Adds/edits saved provider credentials and OpenAI device login. |
| `PiAuthManageModal` | `src/components/modals/PiAuthManageModal.jsx` | Selects saved auth entries for the active harness; never edits models. |
| `GenericEnvironmentModal` | `src/components/modals/GenericEnvironmentModal.jsx` | Creates/edits/deletes masked environment keys and session selection. |
| `WorkspaceModal` | `src/components/modals/WorkspaceModal.jsx` | Creates blank/GitHub workspaces and chooses saved environment keys. |
| `SessionModal` | `src/components/modals/SessionModal.jsx` | Creates the server-selected managed Cloud runner. |
| `SessionEditModal` | `src/components/modals/SessionEditModal.jsx` | Renames/resizes an existing session. |
| `WorkspaceEditModal` | `src/components/modals/WorkspaceEditModal.jsx` | Renames an existing workspace. |
| `GoogleWorkspaceModal` | `src/components/modals/GoogleWorkspaceModal.jsx` | Selects Google services/access before OAuth. |
| `AdminPage` | `src/components/admin/AdminPage.jsx` | Admin user listing and allowlist controls. |
| `ProfilePage` | `src/components/profile/ProfilePage.jsx` | Account profile, usage, and GitHub connector controls. |

Files, Git, model selection, skills, extensions, subagents, and native Goals
are upstream-owned surfaces inside the embedded Agent application. The deleted
Mapache Chat canvas, Workspace Goals panel, file/editor dialogs, Git manager,
model editor, package/extension panel, skills panel, and subagent panel are not
valid component references.

When adding a significant component, update this index and keep ownership in a
focused file rather than expanding `src/main.js`.

## Related docs

- [Frontend architecture](./frontend-architecture.md)
- [Backend API architecture](./backend-api-architecture.md)
- [Runtime containers](./runtime-containers.md)

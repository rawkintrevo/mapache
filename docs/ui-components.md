# UI Components Index

This index maps significant React components to their current responsibilities.

| Component | File | Responsibility |
| --- | --- | --- |
| `App` | `src/App.jsx` | Routes landing, fatal-error, and signed-in app states. |
| `AppShell` | `src/components/layout/AppShell.jsx` | Signed-in full-width workspace layout and modal stack. |
| `Topbar` | `src/components/layout/Topbar.jsx` | Composes workspace selection, power/runtime-policy controls, selected-runtime CPU/RAM meters, the marked-runtime Agent shortcut, workspace actions menu, and user menu. |
| `TopbarPowerMenu` | `src/components/layout/TopbarPowerMenu.jsx` | State-aware power trigger and keyboard-accessible Start, Stop, and Restart menu for the selected workspace runtime. |
| `TopbarUserMenu` | `src/components/layout/TopbarUserMenu.jsx` | Avatar-triggered top-navigation menu for profile, admin, running instances, refresh, and sign-out actions. |
| `TopbarMoreMenu` | `src/components/layout/TopbarMoreMenu.jsx` | Keyboard-accessible workspace menu for New/Edit, Logs/Upload/Automations, Pi auth/environment/MCP/Google/request-access management, documentation, refresh, and destructive Delete. |
| `DrawerSessionList` | `src/components/drawers/DrawerSessionList.jsx` | Retained legacy session-row component; not mounted by the current shell. |
| `WorkspacePanel` | `src/components/workspaces/WorkspacePanel.jsx` | Workspace header/off state or canonical-runtime detail. |
| `WorkspaceHeader` | `src/components/workspaces/WorkspaceHeader.jsx` | Workspace name and source summary. |
| `SessionDetail` | `src/components/sessions/SessionDetail.jsx` | Canonical runtime view with legacy terminal/Agent/Chrome and shell surfaces; marked-runtime lifecycle is controlled from the topbar. |
| `ManagedAgentSurface` | `src/components/sessions/ManagedAgentSurface.jsx` | Borderless, full-height marked-runtime Agent or Persistent Chrome canvas. |
| `PiWebUiCanvas` | `src/components/sessions/PiWebUiCanvas.jsx` | Full-height signed embedded upstream `/agent/` iframe plus exact-origin access-renewal and Chrome-navigation bridge. |
| `WorkspaceUploadModal` | `src/components/modals/WorkspaceUploadModal.jsx` | Selects local files for resumable uploads to `/uploads`, with progress, retry, cancellation, and restart guidance. |
| `SessionLogsModal` | `src/components/modals/SessionLogsModal.jsx` | Displays owner-scoped Cloud Run entries and the current recorded error for the canonical runtime. |
| `BrowserCanvas` | `src/components/sessions/BrowserCanvas.jsx` | Signed Persistent Chrome iframe and pop-out action. |
| `ResourceUtilization` | `src/components/sessions/ResourceUtilization.jsx` | Read-only CPU/RAM metrics surface, rendered in the top navbar for the selected canonical running cloud runtime. |
| `SessionRuntimeStatus` | `src/components/sessions/SessionRuntimeStatus.jsx` | Server-reported runtime/checkpoint/lifecycle status and access errors. |
| `SessionRuntimePolicy` | `src/components/sessions/SessionRuntimePolicy.jsx` | Top-navigation selector for Idle timeout, Keep running, or Scheduled hours; edits weekdays, same-day local times, and timezone, and shows the next transition and strict shutdown behavior. |
| `SessionList` | `src/components/sessions/SessionList.jsx` | Session list for the selected workspace. |
| `SessionResourceSelector` | `src/components/sessions/SessionResourceSelector.jsx` | Shared priced resource presets and advanced CPU/memory fields. |
| `ModalStack` | `src/components/modals/ModalStack.jsx` | Coordinates retained workspace/session/auth/connection dialogs. |
| `AuthModal` | `src/components/modals/AuthModal.jsx` | Adds/edits saved provider credentials and OpenAI device login. |
| `PiAuthManageModal` | `src/components/modals/PiAuthManageModal.jsx` | Selects saved auth entries for the active harness; never edits models. |
| `GenericEnvironmentModal` | `src/components/modals/GenericEnvironmentModal.jsx` | Creates/edits/deletes masked environment keys and session selection. |
| `McpServersModal` | `src/components/modals/McpServersModal.jsx` | Creates, edits, refreshes, and deletes workspace MCP configuration from the top navigation. |
| `GoogleWorkspaceManageModal` | `src/components/modals/GoogleWorkspaceManageModal.jsx` | Lists saved Google accounts and manages the selected workspace binding from the top navigation. |
| `WorkspaceRequestGrantsModal` | `src/components/modals/WorkspaceRequestGrantsModal.jsx` | Owner-managed directional workspace request permissions and revocation for the selected source workspace. |
| `WorkspaceModal` | `src/components/modals/WorkspaceModal.jsx` | Creates blank/GitHub workspaces and chooses saved environment keys. |
| `WorkspaceEditModal` | `src/components/modals/WorkspaceEditModal.jsx` | Renames a workspace and edits its canonical runtime compute size. |
| `GoogleWorkspaceModal` | `src/components/modals/GoogleWorkspaceModal.jsx` | Selects Google services/access before OAuth, then returns to Google Workspace account management. |
| `AdminPage` | `src/components/admin/AdminPage.jsx` | Admin user listing and allowlist controls. |
| `ProfilePage` | `src/components/profile/ProfilePage.jsx` | Account profile, usage, and GitHub connector controls. |
| `AutomationManagementPage` | `src/components/automations/AutomationManagementPage.jsx` | Single Automations entry point that combines workspace definition management with owner-wide run history and run details. |
| `AutomationsPanel` | `src/components/automations/AutomationsPanel.jsx` | Workspace-scoped automation definitions, read-only input/separate output guidance, concurrency limit, CRUD, enable/disable, Run now, queued reasons, and responsive management controls. |
| `AutomationEditor` | `src/components/automations/AutomationEditor.jsx` | Controlled create/edit form for automation instructions, enabled and concurrency settings, model guidance, revision-aware save, and schedule preview. |
| `ScheduleControls` | `src/components/automations/ScheduleControls.jsx` | Daily, weekly, and advanced cron controls with explicit IANA timezone selection and debounced next-run preview. |
| `RunHistoryPage` | `src/components/automations/RunHistoryPage.jsx` | Global run history section with workspace/workflow/status/date filters, cursor pagination, run selection, and embedded/full-page layout support. |
| `RunDetailsPanel` | `src/components/automations/RunDetailsPanel.jsx` | Sanitized archived run details, snapshotted configuration, status actions, restart lineage, and paged conversation/tool event display. |
| `InstancesPage` | `src/components/instances/InstancesPage.jsx` | Owner-wide active main/automation inventory with filters, cursor paging, elapsed/resource/heartbeat summaries, workspace/history links, and targeted Stop actions. |

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

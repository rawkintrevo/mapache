# QA Test Cases

This directory stores opt-in browser QA definitions for Chrome DevTools-assisted testing. Run these only when the user explicitly asks for QA, smoke, browser, or end-to-end testing.

## Structure

- `scripts/`: Single reusable actions. Scripts should do one thing, such as sign in, open a drawer, create a workspace, or capture console/network evidence.
- `cases/`: Ordered test cases. Cases compose scripts and may include other cases through `useCase`.

Store run output under `artifacts/qa/`. The local Vite dev server ignores `artifacts/**`, so screenshots, network dumps, console logs, and result JSON files can be written there during a QA run without crashing the app under test.

## Case Format

Cases are JSON manifests with stable IDs:

```json
{
  "id": "auth.login",
  "title": "QA login reaches signed-in app shell",
  "baseUrl": "http://127.0.0.1:5173",
  "artifactsDir": "artifacts/qa",
  "steps": [
    {"useScript": "scripts/login-qa.json"},
    {"assert": "app-shell-authenticated"}
  ]
}
```

Supported step keys:

- `useScript`: Path to a script manifest under `e2e/qa/`.
- `useCase`: Path to another case manifest under `e2e/qa/`.
- `assert`: Named expectation for the agent to verify using page snapshot, console, network, or deterministic script output.
- `capture`: Artifact request such as `screenshot`, `console`, or `network`.

Common action types inside scripts:

- `click`: Click a control by role/name, label text, placeholder, CSS selector, or snapshot text.
- `fill`: Fill a field by label, placeholder, name, or CSS selector.
- `select`: Choose a select option by label, name, or CSS selector.
- `submit`: Submit the current form or click a named submit button.
- `navigate`: Navigate to a URL.
- `setLocalStorage` / `clearLocalStorageKeys`: Manage browser storage for the target origin.
- `apiRequest`: Run an authenticated request from the page context using the current Firebase user token.
- `confirmDialog`: Accept or dismiss the next browser confirmation dialog.
- `waitForSnapshotText` / `waitForNetwork`: Wait for a visible text or network status.

Keep manifests deterministic. Do not put secrets in case or script files.

Checked-in `e2e/qa/` manifests are intended for Chrome DevTools-assisted execution. Do not assume a standalone local headless Chrome or Playwright launch is available in every sandboxed environment.

## Initial Case Catalog

- `cases/login.json`: QA custom-token login and signed-in shell.
- `cases/app-shell-empty.json`: Empty authenticated shell.
- `cases/navigation-drawers.json`: Left drawer, drawer sections, inspector, refresh.
- `cases/global-action-indicator.json`: Busy indicator during global refresh.
- `cases/profile.json`: Profile and runner usage view.
- `cases/admin.json`: Admin-only user table with whitelist and cost columns.
- `cases/workspace-create-delete.json`: Blank workspace creation and deletion.
- `cases/workspace-github-url.json`: GitHub workspace creation from URL.
- `cases/workspace-files-editor.json`: Workspace file create/edit/download URL.
- `cases/session-create-basic.json`: Basic Pi session creation.
- `cases/session-sidebar-entry-point.json`: Single create-session action in the left sidebar.
- `cases/session-create-all-runners.json`: Blank workspace plus `pi-basic`, `codex-basic`, `pi-web`, and `codex-web` session creation.
- `cases/session-lifecycle.json`: Session resize, restart, stop, delete.
- `cases/auth-provider-api-key.json`: Authentication Center API-key save/delete.
- `cases/auth-github-cli-token.json`: Authentication Center GitHub CLI token save/delete.
- `cases/mcp-servers-crud.json`: Right-drawer MCP server save path for selected workspaces.
- `cases/pi-auth-selection.json`: Manage Pi Auth for a selected Pi session.
- `cases/skills-crud.json`: Workspace-local Pi skill create/edit/delete.
- `cases/skills-crud-codex.json`: Workspace-local Codex skill create/edit/delete.
- `cases/extensions-package-crud.json`: Pi package install/update/remove.
- `cases/git-status.json`: Git status panel for GitHub-backed sessions.
- `cases/git-change-pr-flow.json`: Git stage/commit/push/open PR.
- `cases/full-blank-workspace-smoke.json`: Broad blank-workspace smoke.

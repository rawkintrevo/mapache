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

Managed pi-web cases use `cases/pi-web-marked-workspace-setup.json`. Before
running one, an operator must create a disposable workspace, record its exact
owner/workspace IDs, mark only that workspace with the server-owned
`agentUiVersion=pi-web-ui-v1`, and provide the workspace name as the case
parameter. The browser case does not mark workspaces and does not select by a
production display name. If the marker, provider, browser, Cloud Run service,
or named fault harness is unavailable, record the case as blocked.

The failure-recovery harness is available only on a disposable session created
with `QA_CASE=pi-web-failure-recovery` and
`MAPACHE_QA_FAULT_HARNESS=pi-web-failure-recovery-v1`. Its controls are the
session-scoped `qa-fault-status`, `arm-qa-fault`, `revoke-qa-writer`, and
`force-qa-loss` scripts. They are not general runner controls and must never be
used against the HubSpot source or an unmarked workspace.

Checked-in `e2e/qa/` manifests are intended for Chrome DevTools-assisted execution. Do not assume a standalone local headless Chrome or Playwright launch is available in every sandboxed environment.

## Initial Case Catalog

- `cases/login.json`: QA custom-token login and signed-in shell.
- `cases/app-shell-empty.json`: Empty authenticated shell.
- `cases/navigation-drawers.json`: Left drawer, navbar connection controls, refresh.
- `cases/global-action-indicator.json`: Busy indicator during global refresh.
- `cases/profile.json`: Profile and runner usage view.
- `cases/admin.json`: Admin-only user table with whitelist and cost columns.
- `cases/workspace-create-delete.json`: Blank workspace creation and deletion.
- `cases/workspace-github-url.json`: GitHub workspace creation from URL.
- `cases/session-create-basic.json`: Basic Pi session creation.
- `cases/session-sidebar-entry-point.json`: Single create-session action in the left sidebar.
- `cases/session-create-all-runners.json`: Blank workspace plus the supported `pi-chrome` session creation.
- `cases/session-lifecycle.json`: Session resize, restart, stop, delete.
- `cases/session-resource-sizing.json`: Priced Small/Medium/Large selection, Advanced settings, Custom inference, invalid-pair prevention, resize, and compact summaries.
- `cases/pi-web-marked-workspace-setup.json`: Preflight for one explicitly marked disposable pi-chrome workspace.
- `cases/pi-web-functional.json`: Managed Agent turns, read-only MCP/auth probes, native history, shell coexistence, Chrome/Preview, and native Goal assertions.
- `cases/pi-web-failure-recovery.json`: Bounded disconnect, duplicate-start, writer-fencing, checkpoint, replacement, access-renewal, and no-auto-resume assertions; requires the named deterministic fault harness.
- `cases/auth-provider-api-key.json`: Authentication Center API-key save/delete.
- `cases/auth-github-cli-token.json`: Authentication Center GitHub CLI token save/delete.
- `cases/mcp-servers-crud.json`: Navbar MCP server modal save path for selected workspaces.
- `cases/pi-auth-selection.json`: Manage Pi Auth for a selected Pi session.
- `cases/full-blank-workspace-smoke.json`: Broad blank-workspace smoke for the sole pi-chrome path and navbar connection controls.

Parent-level Files, Git, Skills, Subagents, Extensions, Models, Chat, and Mapache Goals cases are intentionally absent. Upstream Agent owns the live workspace, Git, model, history, skill, and native Goal surfaces; Mapache retains only lifecycle, authentication, MCP, Google Workspace, and migration/persistence boundaries.

Migration-specific checks live in `migration/hubspot-import-checks.md` and use
the Task 24 importer against a restricted immutable backup and isolated target.
They are not browser steps and never authorize a HubSpot CRM write or a source
prefix mutation.

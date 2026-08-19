# Google Workspace MCP connectivity

## Purpose

This page documents the workspace-scoped Google account workflow added for issue 277. It is the source of truth for ownership, OAuth, provisioning, runner persistence, and operational recovery.

## Code ownership

- Google metadata and service catalog: `functions/googleWorkspace.models.js` and `functions/googleWorkspace.catalog.js`
- Private connection records and workspace bindings: `functions/googleWorkspaceConnections.service.js`
- Signed OAuth state, token exchange, refresh, encryption, and revoke: `functions/googleWorkspaceOAuthState.service.js` and `functions/googleWorkspaceOAuth.service.js`
- Authenticated API handlers and route registration: `functions/googleWorkspaceApi.service.js`, `functions/apiRouteManifest.js`, `functions/apiRoutes.helpers.js`, and `functions/apiDispatch.helpers.js`
- Cloud Run environment and MCP injection: `functions/googleWorkspaceProvisioning.service.js` and `functions/cloudRun.service.js`
- Frontend state, controller, workflow, and inspector: `src/state/initialState.js`, `src/controllers/googleWorkspaceController.js`, `src/workflows/googleWorkspace.js`, and `src/components/inspector/GoogleWorkspacePanel.jsx`
- Runner status and persistence: `session-runner/lib/googleMcpStatus.service.js` and `session-runner/lib/workspaceArchives.service.js`

The UI panel is included in the [UI component index](./ui-components.md). The browser QA scenario is `e2e/qa/cases/google-workspace-connections.json`; it enables the browser-only OAuth test double and never uses a real Google account.

## Ownership and data model

Connection records are private to the Firebase user:

```text
users/{uid}/private/googleConnections/entries/{connectionId}
```

The record contains non-secret metadata such as the Google subject, email, display name, status, selected scopes, and timestamps. The encrypted refresh token is stored in the same private record and is never returned by the API. The connection ID is deterministic for a user and Google subject, so reconnecting the same account updates the existing record instead of creating duplicates.

Workspace documents store only the binding:

```json
{
  "googleWorkspaceBinding": {
    "connectionId": "...",
    "enabledServices": ["gmail", "drive"],
    "accessLevel": "read",
    "updatedAt": "..."
  }
}
```

Every read and mutation verifies the authenticated user owns the connection and workspace. Unbinding changes only that workspace. Deleting a saved connection revokes its Google token when possible, removes the private record, and removes bindings to that connection from every owned workspace; the UI displays the affected workspace count before deletion.

## OAuth and service catalog

The backend starts authorization with a signed, short-lived, single-use state containing the user, workspace, nonce, and requested services. The callback validates that state before exchanging the code, fetching the Google account identity, encrypting the refresh token, and binding the resulting connection to the initiating workspace. Callback responses are small HTML pages that close the OAuth popup and leave the app to refresh its workspace state.

The catalog currently exposes Gmail, Drive, Docs, Sheets, Slides, Calendar, Chat, and People. The service URLs and scope choices follow Google's [Configure Google Workspace MCP servers](https://developers.google.com/workspace/guides/configure-mcp-servers) guide. Read-only access is the default; write access is offered only for services whose catalog entry explicitly lists write scopes. Google Cloud API enablement, OAuth consent-screen configuration, Workspace administrator restrictions, and user consent remain deployment prerequisites outside the app.

The required Functions configuration is:

- `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_REDIRECT_URI` parameters.
- `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_STATE_SECRET`, and `GOOGLE_OAUTH_ENCRYPTION_KEY` Functions secrets.

The encryption key must remain stable while records exist. Rotating it requires a deliberate migration or a controlled reconnect of all affected accounts; do not change it casually.

## Provisioning and runner behavior

When a new Cloud Run session is created, or an existing session is restarted, Functions resolves the workspace binding, refreshes the Google connection, and builds an ephemeral runner-specific runtime:

- selected Google MCP servers are merged into the workspace MCP config using Google's HTTPS MCP URLs;
- the refreshed access token is passed only as the `GOOGLE_MCP_ACCESS_TOKEN` Cloud Run environment value;
- safe account and service metadata is passed separately for status reporting;
- `MCP_CONFIG` contains a `bearer_env` entry that refers to the token environment variable, never the token literal.

If refresh returns `invalid_grant`, the connection is marked `reconnect_required` and provisioning stops with a reconnectable error. The frontend tells users that current sessions need restart after changing or disconnecting a binding. Restart uses the latest workspace binding and refreshes the token again; sessions created before a change do not silently change their MCP servers.

Pi and Codex render the normalized MCP config through their native adapters. Pi OAuth material is archived separately under the hidden workspace prefix:

```text
{workspaceStoragePrefix}/.mapache-internal/pi-mcp-oauth/mcp-oauth.tar.gz
```

The general home archive excludes that directory so it cannot be duplicated across archive targets. Codex MCP configuration is workspace-local at `/workspace/.codex/config.toml`; Codex CLI state remains in its workspace-scoped `CODEX_HOME` archive. Runner `GET /google/mcp/status` reports only configured services, connection state, adapter, and safe account metadata. It never reports tokens, credential file contents, or archive paths.

## API surface

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/google/services` | Read the supported service catalog. |
| `GET` | `/api/google/connections` | List the user's safe connection summaries and workspace usage. |
| `GET` / `DELETE` | `/api/google/connections/{connectionId}` | Inspect or remove one saved connection. |
| `GET` | `/api/workspaces/{workspaceId}/google` | Read the workspace binding and catalog. |
| `POST` | `/api/workspaces/{workspaceId}/google/connect` | Start OAuth for the selected services. |
| `POST` / `DELETE` | `/api/workspaces/{workspaceId}/google/binding` | Bind, change, or unbind a saved connection. |
| `GET` | `/google/mcp/status` | Read safe runner-local MCP status; protected by the runner shutdown token. |

## Deployment and recovery

Deploy Functions with the explicit production project:

```bash
firebase deploy --only functions --project pi-agents-cloud
```

The runner status and Pi archive changes require a rebuilt runner image. Build the affected standard images with the checked-in Cloud Build configuration and explicit project flag, then restart or recreate existing sessions before expecting them to use the new runtime:

```bash
gcloud builds submit session-runner --project pi-agents-cloud --tag us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:latest
```

Before production use, verify the three OAuth secrets, redirect URI, Google Cloud APIs, consent screen, and any Workspace administrator policy. If a rollout must be reversed, deploy the previous Functions revision/image, restart affected sessions, and revoke or delete the saved Google connections through the UI/API. Existing sessions retain their already-provisioned environment until they are stopped or restarted.

## Verification

- `npm run docs:check`
- `npm --prefix functions test && npm --prefix functions run lint`
- `npm --prefix session-runner run lint && npm --prefix session-runner test`
- `npm run test:frontend && npm run build`
- Chrome DevTools QA through the existing browser at `127.0.0.1:9222` using `e2e/qa/cases/google-workspace-connections.json`

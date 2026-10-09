# Google Workspace MCP connectivity

## Purpose

This page documents the workspace-scoped Google account workflow added for issue 277. It is the source of truth for ownership, OAuth, provisioning, runner persistence, and operational recovery.

## Code ownership

- Google metadata and service catalog: `functions/googleWorkspace.models.js` and `functions/googleWorkspace.catalog.js`
- Private connection records and workspace bindings: `functions/googleWorkspaceConnections.service.js`
- Signed OAuth state, token exchange, refresh, encryption, and revoke: `functions/googleWorkspaceOAuthState.service.js` and `functions/googleWorkspaceOAuth.service.js`
- Running-session access-token broker: `functions/googleMcpTokenBroker.service.js` and the `googleMcpToken` Function export in `functions/index.js`
- Authenticated API handlers and route registration: `functions/googleWorkspaceApi.service.js`, `functions/apiRouteManifest.js`, `functions/apiRoutes.helpers.js`, and `functions/apiDispatch.helpers.js`
- Cloud Run environment and MCP injection: `functions/googleWorkspaceProvisioning.service.js` and `functions/cloudRun.service.js`
- Runner MCP tool registration and Google REST writes: `session-runner/google-workspace-mcp/server.mjs`, `docsWrites.mjs`, `slidesWrites.mjs`, `sheetsWrites.mjs`, `driveWrites.mjs`, and `restClient.mjs`
- Frontend state, controller, workflow, navbar management modal, and connection editor: `src/state/initialState.js`, `src/controllers/googleWorkspaceController.js`, `src/controllers/modalController.js`, `src/workflows/googleWorkspace.js`, `src/components/layout/Topbar.jsx`, `src/components/modals/GoogleWorkspaceManageModal.jsx`, and `src/components/modals/GoogleWorkspaceModal.jsx`
- Runner token renewal, status, and persistence: `session-runner/lib/googleMcpTokenApi.service.js`, `session-runner/lib/googleMcpStatus.service.js`, and `session-runner/lib/workspaceArchives.service.js`

The UI panel is included in the [UI component index](./ui-components.md). The browser QA scenario is `e2e/qa/cases/google-workspace-connections.json`; it enables the browser-only OAuth test double and never uses a real Google account.

## Ownership and data model

Connection records are private to the Firebase user:

```text
users/{uid}/private/googleConnections/entries/{connectionId}
```

The record contains non-secret metadata such as the Google subject, email, display name, status, selected scopes, and timestamps. Scope metadata accepts HTTPS Google API scopes plus the exact standard OpenID Connect scope names `openid`, `email`, and `profile`; other non-URL scope values are rejected. The non-secret OAuth client reference accepts the bounded dotted identifier format used by Google client IDs, including the `.apps.googleusercontent.com` suffix. The encrypted refresh token is stored in the same private record and is never returned by the API. The connection ID is deterministic for a user and Google subject, so reconnecting the same account updates the existing record instead of creating duplicates.

The `Manage Google Workspace` icon in the top navigation opens
`GoogleWorkspaceManageModal`, which presents saved Google accounts as the
complete Google Workspace summary for the selected workspace. Its accessible
label and mouseover title follow the same icon-button convention as MCP server
management. A checked account is enabled for the selected workspace; its
toggle removes that workspace binding. An unplugged account is disabled for
the selected workspace; its toggle restores the binding using the account's
already-authorized services. Add and edit actions transition to
`GoogleWorkspaceModal`, where the user chooses Workspace services and
read-only or read/write access before starting Google authorization; closing
the editor returns to account management. Deleting an account remains a
user-global operation with an affected-workspace confirmation. Binding changes
affect newly created or restarted sessions because a running session keeps the
Google MCP configuration provisioned at startup.

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

Saved connection metadata also carries the explicit, default-off
`gmailPermanentDeleteEnabled` setting. The setting is account-scoped, so every
workspace binding for that account receives the same configured capability;
the runner still requires the Gmail binding and the actual
`https://mail.google.com/` grant before registering permanent-delete tools.

Every read and mutation verifies the authenticated user owns the connection and workspace. Unbinding changes only that workspace. Deleting a saved connection revokes its Google token when possible, removes the private record, and removes bindings to that connection from every owned workspace; the UI displays the affected workspace count before deletion.

## OAuth and service catalog

The backend starts authorization with a signed, short-lived, single-use state containing the user, workspace, nonce, reconnect intent, and requested services. Every authorization request includes the base `openid`, `email`, and `profile` scopes required to identify the connected account, in addition to the selected Workspace service scopes. It requests consent and account selection together so Google reliably returns the offline refresh token even when the user previously granted the OAuth client access but Mapache has no saved connection. Before exchanging the code, the callback atomically creates a nonce record at `users/{uid}/private/googleOAuthState/attempts/{nonce}` in Firestore. This makes replay protection durable across Functions instances and cold starts; a second callback is rejected before token exchange. These records contain no tokens and retain their signed expiry for cleanup. An explicit reconnect/change-account flow does not fall back to an old refresh token if Google omits a replacement.

The catalog exposes Gmail, Drive, Docs, Sheets, Slides, and Calendar. Chat and People remain intentionally outside the supported product set. Read-only access is the default; write access is offered only for services whose catalog entry explicitly lists write scopes. Gmail write access exposes named archive tools that remove only `INBOX`. Permanent message/thread deletion is a separate default-off Gmail permission in the connection editor. Selecting it requires Gmail write access, requests the restricted `https://mail.google.com/` scope, and records the opt-in in connection metadata; a previously granted broad scope does not enable it when the setting is false. Calendar write access requests the least-privilege `https://www.googleapis.com/auth/calendar.events` scope so its MCP server can create, update, respond to, and delete events. The local REST-backed path does not require Google's Developer Preview program or hosted MCP-service enablement. Google API enablement, OAuth consent-screen configuration, Workspace administrator restrictions, and user consent remain deployment prerequisites outside the app.

The local Gmail search and draft-list tools map the Gmail API's `threads` and `drafts` response collections explicitly into the shared paginator. Keep those service-specific collection keys when changing pagination; the shared client defaults to an `items` collection, and using that default for Gmail silently produces empty connector results even when Google returned matches.

Drive search and recent-file listing likewise pass `itemsKey: "files"` to the shared paginator because Drive v3 returns its collection under `files`; single-file metadata and permission calls use endpoint-specific field masks. Sheets metadata, values reads, values writes, batch updates, and dimension insertion use the dedicated `https://sheets.googleapis.com/v4` service endpoint rather than the shared `www.googleapis.com` host; the real REST-client regression tests assert the resolved host and paths for each operation. The local health tool performs bounded read-only probes for Gmail, Drive, and Calendar through the same REST client and reports Docs, Sheets, and Slides as unverified when no resource identifier is available. Deploying a Sheets REST-client or tool change requires rebuilding and publishing `pi-chrome`; existing workspaces need a restart through the normal lifecycle to receive the corrected runner revision. Reauthorizing the Google account alone does not update runner code.

Drive read access includes a unified `drive_read_file` tool. It returns ordinary textual files as bounded UTF-8, exports Google Docs and Slides as plain text, exports Google Sheets as CSV, and preserves a bounded base64 fallback for binary files. Native export uses the existing Drive read-only scope, so users who enabled Drive can inspect native content without separately enabling the Docs, Sheets, or Slides service. The legacy `drive_download_file` tool remains available for callers that explicitly need base64 bytes and continues to reject Google-native files.

Write-capable runner connections expose the following bounded creation contracts:

- `sheets_create_spreadsheet` requires the Sheets write scope, calls the Sheets API's `spreadsheets.create` method with `{properties: {title}}`, and returns the created `spreadsheetId` plus an editable Google Sheets URL. The returned ID can be passed directly to the existing Sheets value and dimension tools.
- `drive_create_file` treats `mimeType` as the destination type and optional `contentMimeType` as the uploaded media type. Ordinary text and binary files continue to use multipart uploads, defaulting the media type to `mimeType`. To import CSV into a native spreadsheet, set `mimeType` to `application/vnd.google-apps.spreadsheet`, set `contentMimeType` to `text/csv`, and provide non-empty content. To create a blank native spreadsheet through Drive, omit `content` and `contentMimeType`; this uses a metadata-only JSON request and never uploads empty media. Blank Docs (`application/vnd.google-apps.document`) and Slides (`application/vnd.google-apps.presentation`) use the same metadata-only path, including optional parent folders. Docs imports accept plain text, HTML, RTF, Word, or OpenDocument text; Slides imports accept PowerPoint or OpenDocument presentations. Set the source `contentMimeType` explicitly and use `encoding: "base64"` for binary uploads. Unsupported destinations and media combinations are rejected before making a request.

- `docs_create_document` and `slides_create_presentation` create named blank native files and return their IDs and editable URLs. Populate them with the existing bounded batch-update tools. They use the same service/scope gates as their respective edit tools; Drive-only connections can create native files through `drive_create_file`.

These tools are registered only when the connection has the relevant write scope; read-only connections do not expose them.

Docs reads, creation, and batch updates use `https://docs.googleapis.com/v1`; Slides uses `https://slides.googleapis.com/v1`. Do not route these operations to `www.googleapis.com/docs/v1` or `/slides/v1`, which can return HTML error pages. Drive metadata, copy, upload, and export keep their Drive v3 endpoints.

The shared REST client preserves HTTP error classification and retryability even when Google returns HTML or plain text. MCP error results include `status`, `retryable`, and a bounded diagnostic excerpt with markup, script/style bodies, and credentials removed. A non-JSON success response still reports `google_invalid_json` with diagnostic text; successful byte downloads remain unchanged. The existing single 401 renewal/retry happens before interpreting the final response. Upstream diagnostic text is untrusted provider content, not agent instructions.

Deploy these runner-only changes by rebuilding and publishing `pi-chrome`; existing sessions require restart/recreation to receive a new revision. No Functions deployment or new OAuth scopes are required. Read-only connections still need write authorization before creation is available.

The required Functions configuration is:

- `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_REDIRECT_URI` parameters.
- `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_STATE_SECRET`, and `GOOGLE_OAUTH_ENCRYPTION_KEY` Functions secrets.

The encryption key must remain stable while records exist. Rotating it requires a deliberate migration or a controlled reconnect of all affected accounts; do not change it casually.

## Provisioning and runner behavior

When a new Cloud Run session is created, or an existing session is restarted, Functions resolves the workspace binding, refreshes the Google connection, and builds an ephemeral runner-specific runtime:

- local mode merges one `google-workspace` stdio entry running `/app/google-workspace-mcp/server.mjs`;
- selected service keys and granted scopes are passed as non-secret `GOOGLE_MCP_ENABLED_SERVICES` and `GOOGLE_MCP_GRANTED_SCOPES` values;
- the account's explicit Gmail deletion setting is passed as the default-false
  `GOOGLE_MCP_GMAIL_PERMANENT_DELETE_ENABLED` value; the runner requires both
  this value and the exact full Gmail scope before exposing permanent-delete
  tools;
- Google MCP entries request automatic modern/legacy protocol negotiation so Pi can connect to Google's stateless MCP endpoints instead of defaulting to the adapter's legacy-only handshake;
- the refreshed access token is passed only as the `GOOGLE_MCP_ACCESS_TOKEN` Cloud Run environment value in either mode;
- the runner receives the safe connection identifier and dedicated `googleMcpToken` Function URL for its private renewal adapter; the local MCP process receives only a mode-0600 Unix socket path and never receives the broker URL, connection identifier, or runner shutdown credential;
- safe account and service metadata is passed separately for status reporting;
- `MCP_CONFIG` contains a `bearer_env` entry that refers to the token environment variable, never the token literal.

`functions/cloudRun.service.js` validates workspace, session, and saved generic environment values before appending this backend-generated Google runtime environment. Keep the trusted runtime values outside the user-env normalization map: their names are intentionally reserved from user input, and passing them back through reserved-name validation prevents bound sessions from starting or restarting.

If refresh returns `invalid_grant`, the connection is marked `reconnect_required` and provisioning stops with a reconnectable error. The frontend tells users that current sessions need restart after changing or disconnecting a binding. Restart uses the latest workspace binding and refreshes the token again; sessions created before a change do not silently change their MCP servers.

The local REST client retries a Google request once after a 401. It calls the runner-owned mode-0600 `google-mcp-token-*.sock`; the runner supplies the workspace ID, session ID, provisioned connection ID, and shutdown credential when calling the dedicated token-broker Function. The broker verifies that the session exists, is running, owns that shutdown credential, and is still bound to the same Google connection before Functions decrypts the saved refresh token. Successful responses contain only a new short-lived access token, use `Cache-Control: no-store`, and are cached only in the MCP process. Concurrent 401 responses share one in-process refresh request, and a second 401 is returned without another retry. The broker never returns or provisions the Google refresh token, OAuth client secret, or encryption key. If renewal is unavailable, the client reports a distinct transport/configuration error rather than silently treating the request as a normal expired token.

Pi renders the normalized MCP config through the pinned `pi-mcp-adapter@2.32.1`, discovered once through the SDK extension loader, and reads the runner-materialized `/workspace/.mcp.json`; its legacy MCP bridge and connection editor are disabled. Google uses a `bearer_env` entry, so the adapter sees only the environment-variable name and the local wrapper keeps the refreshed access token in process memory. No access token is copied into persisted UI state or MCP config. Pi OAuth material is archived separately under the hidden workspace prefix:

```text
{workspaceStoragePrefix}/.mapache-internal/pi-mcp-oauth/mcp-oauth.tar.gz
```

The general home archive excludes that directory so it cannot be duplicated across archive targets. Runner `GET /google/mcp/status` reports process readiness separately from enabled-service verification, along with the adapter, safe account metadata, and evidence-backed state. For local mode, the runner performs local MCP initialize/tools-list readiness and a bounded health probe through the same Google REST client. Drive, Gmail, and Calendar report `verified` when their read-only probe succeeds; Docs, Sheets, and Slides report `unverified` when a resource-specific probe cannot be performed. Each checked service includes a timestamp and normalized error category; polling is coalesced and cached for 15 seconds. It never reports tokens, credential file contents, commands, file/message identifiers, or archive paths.

## API surface

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/google/services` | Read the supported service catalog. |
| `GET` | `/api/google/connections` | List the user's safe connection summaries and workspace usage. |
| `GET` / `DELETE` | `/api/google/connections/{connectionId}` | Inspect or remove one saved connection. |
| `GET` | `/api/workspaces/{workspaceId}/google` | Read the workspace binding and catalog. |
| `POST` | `/api/workspaces/{workspaceId}/google/connect` | Start OAuth for the selected services. |
| `POST` / `DELETE` | `/api/workspaces/{workspaceId}/google/binding` | Bind, change, or unbind a saved connection. |
| `POST` | `googleMcpToken` Function URL | Refresh a running session's short-lived Google access token; protected by its shutdown credential and connection binding. |
| `GET` | `/google/mcp/status` | Read safe runner-local MCP status; protected by the runner shutdown token. |

## Deployment and recovery

Deploy Functions with the explicit production project:

```bash
firebase deploy --only functions --project pi-agents-cloud
```

The runner status, Pi archive, and local Google REST client changes require rebuilt runner images. Build the affected standard images with the checked-in Cloud Build configuration and explicit project flag, then restart or recreate existing sessions before expecting them to use the new runtime. Token renewal specifically requires both the Function and runner revisions: an older session does not have the broker URL and connection metadata in its environment.

```bash
gcloud builds submit session-runner --project pi-agents-cloud --tag us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:pi-chrome
```

Before production use, verify the three OAuth secrets, redirect URI, Google Cloud APIs, consent screen, and any Workspace administrator policy. The OAuth consent screen's Data Access configuration must include `https://www.googleapis.com/auth/calendar.events` before users connect Calendar with read/write access and `https://mail.google.com/` before users opt into permanent Gmail deletion. Existing read/write connections continue without reauthorization; users who enable permanent deletion must reconnect the saved account to obtain the additional grant, then restart or recreate affected sessions to receive the new runner environment. Disabling the setting does not rely on revoking the broad scope: the persisted opt-in remains the independent gate. If a rollout must be reversed, deploy the previous Functions commit/revision and its matching runner image tags, restart affected sessions, and revoke or delete the saved Google connections through the UI/API. Existing sessions retain their already-provisioned environment until they are stopped or restarted.

## Verification

- `npm run docs:check`
- `npm --prefix functions test && npm --prefix functions run lint`
- `npm --prefix session-runner run lint && npm --prefix session-runner test`
- `functions/googleWorkspaceIsolation.test.js` and `session-runner/google-workspace-mcp/isolation.test.mjs` cover workspace token isolation, secret redaction, and read-only/write tool gating.
- `npm run test:frontend && npm run build`
- Chrome DevTools QA through the existing browser at `127.0.0.1:9222` using `e2e/qa/cases/google-workspace-connections.json`

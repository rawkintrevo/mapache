# Backend API Architecture

This page owns the Cloud Functions API, Firestore ownership boundaries, and
Cloud Run provisioning contract.

## Canonical owners

- Entrypoint and dependency composition: `functions/index.js`
- Route contract/parser/dispatch: `functions/apiRouteManifest.js`,
  `functions/apiRoutes.helpers.js`, and `functions/apiDispatch.helpers.js`
- Handler registry: `functions/apiHandlers.helpers.js`
- Workspace lifecycle: `functions/workspace.service.js`
- Session creation/lifecycle/provisioning: `functions/sessionCreation.service.js`,
  `functions/sessionLifecycle.service.js`, and `functions/cloudRun.service.js`
- Owner-scoped Cloud Run log reads: `functions/sessionLogs.service.js`
- Signed browser/agent access and preview publication: `functions/preview.service.js`
- Credentials and environment keys: `functions/agentAuth.service.js`,
  `functions/environmentKeys.service.js`, and
  `functions/openAiCodexAuth.service.js`
- MCP and Google connections: `functions/googleWorkspace*.js` and the workspace
  MCP handlers
- GitHub account/source automation: `functions/github*.service.js` and
  `functions/github.service.js`
- Runner image contract: `functions/runnerCatalog.json` and
  `functions/runnerCatalog.helpers.js`

## Current API boundary

The API authenticates Firebase ID tokens, applies the configured app allowlist,
and enforces the Firebase UID as the workspace/session ownership boundary. The
route manifest is shared by parsing, method validation, dispatch, and contract
tests. The unauthenticated QA custom-token route is separately gated by the QA
secret and controlled account configuration; public preview reads are limited to
recorded preview objects.

Retained authenticated responsibilities are:

- profile/admin and allowlist operations;
- blank/GitHub workspace create/list/rename/delete;
- session create/list/rename/access/lifecycle, owner-scoped runtime logs, and
  signed Agent/Chrome/Preview access;
- checkpoint/runtime QA fault controls used only by the disposable harness;
- retained SSH compatibility file/forward routes for already-running historical
  SSH records;
- Mapache-owned credential selection, generic environment keys, workspace MCP,
  Google Workspace connections, and GitHub account/repository connections.

The embedded upstream application owns the agent protocol and its live files,
Git, models, skills, extensions, subagents, and native Goals. Mapache does not
proxy or reimplement those surfaces. In particular, there are no deployed
workspace Goals routes, old Chat route, manual workspace-file editor API,
manual Git action API, package CRUD API, model editor API, or skill/subagent
CRUD API in the current manifest.

## Workspace and session state

Session creation and resize share `normalizeRequestedSessionResources` from
`functions/index.js`; it must be supplied to both service dependency objects.
Resize validates resources before stopping or recreating a managed runtime.

Resize requests return HTTP 202 after `sessionResize.service.js` transactionally
records a `resizeOperationId`, requested resources, and `queued` state on the
session. The `resizeQueuedSession` Firestore worker claims that operation and
runs the existing stop/recreate flow, then publishes `completed` or `failed`
and an owner-visible error. The HTTP request never waits for shutdown or Cloud
Run startup, which can exceed Firebase Hosting's 60-second timeout. Identical
pending requests reuse the operation; conflicting sizes and competing session
lifecycle actions are rejected. Duplicate deliveries cannot overlap: a running
claim is retried only after ten minutes, beyond the worker's 540-second limit.
Deploy the worker before the API so accepted operations have a consumer.

Workspace documents carry owner, source, storage, sync, MCP, home-policy, and
workspace-level resource metadata. They also carry a lazily populated
`canonicalSessionId`; existing workspaces adopt an active child session first,
otherwise the most recently updated child. Sessions remain below the workspace
and carry the resolved runner identity, lifecycle state, resource allocation,
access metadata, idle-timeout policy, and runtime generation/boot authority
fields. New sessions persist `longRunning: false`; the authenticated session
long-running policy route may change that field only for marked managed
runtimes. New blank and GitHub workspaces receive the server-owned
`agentUiVersion: "pi-web-ui-v1"` marker. New sessions use the workspace resource setting and resolve the curated
`pi-chrome` image and Pi harness regardless of browser payloads.

The workspace authority transaction admits one managed runtime and sync writer.
Generation and boot-instance fencing prevent a stale Cloud Run container from
publishing checkpoints or being mistaken for its replacement. The provisioning
worker repeats the pi-chrome identity check before creating a per-session Cloud
Run service. Historical unsupported records remain readable but cannot be
converted into newly launched unsupported runners.

Agent access is a short-lived signed URL/cookie flow with an `agent` audience,
session identity, and current runtime generation. The runner gateway, not the
browser, validates the token before forwarding to upstream. Browser, terminal,
preview, metrics, and retained SSH access use their separate existing contracts.
The authenticated session Logs route verifies workspace/session ownership and
queries only the session's recorded Cloud Run service name. Responses are
bounded to timestamp, severity, and message fields; request query strings and
broader Logging metadata are not exposed to the browser.

## Scheduled automation data boundary

Scheduled automation definitions live at
`workspaces/{workspaceId}/automations/{automationId}` and owner-wide run records
live at `automationRuns/{runId}`. `functions/automationValidation.helpers.js`
owns the bounded DTOs and validation rules: names are at most 120 characters,
prompts at most 32,768 characters, cron and IANA timezone strings at most 100
characters, and definition revisions and workspace automation concurrency are
positive safe integers. Definitions default to disabled with
`allowParallelWithMain: true`; runs carry an immutable prompt/definition
snapshot and use the `queued` → `provisioning` → `running` → `stopping` →
terminal state contract from `functions/automationState.helpers.js`.

`functions/runtimePaths.helpers.js` normalizes missing `runtimeKind` to `main`
and provides the deterministic `auto-{runId}` automation session identity. The
Firestore rules expose definitions and runs only to the owning user and deny
client writes; automation concurrency settings are backend-owned workspace
fields. The corresponding due-definition, owner-history, queue, and cleanup
query shapes are declared in `firestore.indexes.json`.

The authenticated profile route accepts `PATCH /api/me` with only an IANA
`timezone` field. `POST /api/automation-schedule-preview` validates a numeric
five-field cron expression and returns the next five `{utc, local, timezone}`
occurrences using server time; the client cannot supply `nextRunAt` or preview
time. The schedule matcher preserves standard day-of-month/day-of-week OR
semantics, skips nonexistent DST minutes, and de-duplicates repeated local
minutes to the first occurrence.

## Persistence and connections

Marked runners capture complete Pi JSONL history, allowlisted non-secret UI/Pi
settings, referenced uploads, and workspace files into immutable Cloud Storage
objects. A generation/boot-checked Firestore pointer publishes a manifest. A
partial or stale capture cannot replace the last good pointer. Restore validates
identity, checksums, paths, JSON/JSONL content, and symlinks before installing
state and before upstream launch. Auth and connector material are excluded from
agent snapshots and materialized afresh from Mapache-owned private stores.

Workspace MCP configuration stores normalized transport metadata and references
generic environment names rather than secret values. Google bindings store only
connection IDs and selected services; token refresh/materialization happens
server-side during provisioning. GitHub installation tokens are short-lived and
are used for source clone or internal automation without being written to
workspace files, logs, or persisted session metadata.

The `githubAutomationToken` HTTPS Function is a bounded credential broker. It
accepts only a running session's workspace/session IDs and shutdown token,
rechecks the workspace's connected installation and repository against the
owner's current GitHub App connection, and returns only a short-lived token and
expiry with `Cache-Control: no-store`.

## Invariants

- Functions, not the browser, chooses the runner image and enforces lifecycle
  and workspace concurrency.
- Credentials, connection bindings, access tokens, and shutdown tokens never
  appear in public workspace/session data or ordinary agent snapshots.
- Route handlers stay small and delegate domain behavior to focused services.
- Removed legacy route names must remain absent from both the parser and
  dispatcher; source migration code may mention historical declarations only in
  its explicitly scoped import/sanitation path.
- Changes to Functions require an explicit `pi-agents-cloud` deployment before
  handoff unless the user explicitly defers deployment.

## Verification

- `npm --prefix functions test`
- `npm --prefix functions run lint`
- `npm run generate:runner-catalog -- --check`
- `npm run docs:check`

## Related docs

- [Frontend architecture](./frontend-architecture.md)
- [Runtime containers](./runtime-containers.md)
- [Session runner architecture](./session-runner-architecture.md)
- [Runner harnesses](./runner-harnesses.md)
- [Deployment](./deployment.md)

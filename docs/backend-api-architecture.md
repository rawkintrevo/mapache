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

Automation sessions are a separate runtime identity: each run uses the
deterministic `auto-{runId}` session ID and stores its generation, boot, writer
authority, and checkpoint pointer on that session document. Automation sessions
do not become the workspace canonical session, do not claim the workspace
singleton runtime or sync-writer lease, and are excluded from the main session
listing, user lifecycle controls, and idle reaper. Missing `runtimeKind`
continues to mean `main` for legacy sessions.

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

`functions/automationDefinitions.service.js` owns the workspace-scoped
definition/settings API. Definition DTOs contain only workflow fields and
model/provider IDs; ownership is checked through the workspace owner, edits
and deletes require the current revision, and edits append field-name-only
audit records. Deletion is a tombstone: ordinary lists exclude it, queued
runs are canceled transactionally, and provisioning/running/stopping history
is left untouched. Disabled definitions can be saved before shared storage is
ready; enabling requires a saved model selection and ready shared storage.
Workspace concurrency changes only the admission limit, so lowering it never
stops active allocations.

`functions/automationRuns.service.js` owns immutable run admission. Manual
requests use UUIDs; cron requests use a SHA-256 ID derived from the automation
and local schedule minute. A transaction captures the current definition
revision, prompt, timezone, model reference, parallelism policy, and resource
snapshot, then sets the definition's `pendingRunId` without calling Cloud Run.
The same transaction handles cron queue-full skips, pending-run rejection for
manual/restart requests, owner/workspace/storage checks, and scoped
Idempotency-Key digests. `POST /api/workspaces/{workspaceId}/automations/{automationId}/run`
accepts disabled definitions but not tombstones; terminal historical runs can
be restarted through `POST /api/automation-runs/{runId}/restart` using their
saved snapshot, even after the definition is tombstoned. `POST
/api/automation-runs/{runId}/cancel` atomically cancels only queued work and
clears `pendingRunId` when it still points at that run. Credentials and files
remain current at launch rather than being copied into the run snapshot.
`functions/automationAdmission.service.js` owns the next transaction boundary:
it counts provisioning/running/stopping runs plus terminal runs whose cleanup is
still pending, applies the workspace concurrency limit, and admits the oldest
eligible `(createdAt, runId)` candidate. A queued `allowParallelWithMain: false`
candidate is skipped while the main session is not confirmed stopped, so a later
parallel candidate can proceed without head-of-line blocking. Admission records
`automationActiveRunIds` and, for an exclusive run,
`automationMainExclusionRunId` on the workspace; main start/play/restart/resize
paths reject that reservation with `automation_requires_main_paused`, while a
pending queue alone never blocks main use. Only confirmed service cleanup can
release the slot, and that release wakes the queue. Enqueue, cancellation,
concurrency-setting changes, and confirmed main-stop completion use the same
idempotent queue wake path.
`functions/automationScheduler.service.js` is the single minute-tick scheduler
used by the `dispatchAutomationSchedules` function. It reads the
`appConfig/automations` feature flag before querying bounded pages of enabled,
due definitions. A delivery more than 120 seconds late is ignored. Timely ticks
recheck the definition in a transaction, use the stored timezone's local
minute (including DST repeat suppression), create one deterministic cron run,
advance `nextRunAt`, and compress older due occurrences into one skipped-range
history record. A pending workflow run produces skipped queue-full history;
the scheduler never calls a provider or replays a missed backlog. The flag is
off by default, so re-enabling it does not backfill old schedule ticks.

`functions/workspaceStorageMigration.service.js` owns the paused-workspace
GCS FUSE cutover. `POST /api/workspaces/{workspaceId}/automation-storage/prepare`
acquires an idempotent migration reservation, rejects new main/automation
admissions while it is active, and returns a short-lived import descriptor with
HTTP 202. The maintenance importer uploads a fresh tree generation and verifies
its hashes and ready marker; only a transaction that rechecks paused sessions,
operation identity, and the verified marker publishes `sharedStorage.state=ready`
and `shared-gcsfuse-v1`. Failures retain the legacy checkpoint/prefix as the
authority and expose a safe error/progress state.

Automation execution artifacts are independent of the compute lifecycle.
`session-runner/lib/automationArtifacts.service.js` writes sanitized, immutable
versioned JSONL event/transcript chunks and a final summary below the private
workspace path `automation-runs/{runId}`. It publishes a Firestore pointer only
after every object is complete and the workspace, session, generation, and boot
identity still match; partial or stale captures therefore leave the previous
good pointer intact. `functions/automationHistory.service.js` exposes
owner-scoped run and artifact history readers with opaque cursors, checksum and
namespace validation, and bounded pages (200 records or 1 MiB for events).

`functions/automationProvisioning.service.js` is the dedicated consumer for
admitted `provisioning` runs. It claims the run idempotently, creates the
deterministic `auto-{runId}` session and `mpauto-{runId-hash}` Cloud Run
service, and leaves `canonicalSessionId` and main-runtime reservations alone.
The ordinary queued-session worker skips automation sessions; run/session
Firestore workers reconcile duplicate deliveries and response loss against the
same session operation. Cloud Run creation reuses the trusted `pi-chrome`,
runner service account, fresh credential/MCP resolution, and ready shared GCS
FUSE descriptor, while automation labels fence owner/workspace/run identity.
Provisioning operations have a 15-minute infrastructure deadline rather than
an execution-duration cap. A failure records a stable error and desired
`failed` outcome with `cleanupState=pending`, retaining the concurrency slot
until the later cleanup path confirms service absence.

`POST /api/automation-runs/{runId}/stop` is the owner-authorized cancellation
boundary. Queued runs are canceled in their admission transaction; admitted
runs move to `stopping` with `desiredOutcome=canceled`, then the cleanup worker
uses the same run-scoped shutdown path as normal completion. Stop and completion
are serialized by the run transaction, so a committed cancellation wins until
a terminal outcome has already been committed. Cleanup deletes only the
deterministic automation Cloud Run service, confirms absence, finalizes the
run, releases exactly one concurrency reservation, and wakes the queue. A
failed deletion leaves the run stopping or terminal with `cleanupState=error`
and retains its slot for a later retry. Forced or incomplete checkpoint saves
surface `persistenceState=partial` and never claim that all files were saved.

`reconcileAutomationRuns` runs every minute with bounded run and Cloud Run
pages. It resumes provisioning and pending cleanup, treats a heartbeat older
than three minutes as a reason to probe the protected runner health endpoint
and inspect the deterministic labeled service, and never treats elapsed
runtime or a missed heartbeat alone as permission to replay a prompt. An
unreachable runner is interrupted only after service deletion is confirmed;
ambiguous Cloud Run state retains the reservation. Orphan discovery filters
for automation labels, rechecks metadata before deletion, and never targets a
main session service.

An admitted automation runner resolves its assignment from the owner-bound run
record only after its session boot has been admitted. The runner claims
`executionStartedAt` exactly once before invoking the private pi-web-ui
`startAutomation` control, publishes `executionHeartbeatAt` while polling, and
writes only normalized outcomes (`succeeded`, `failed`, `canceled`, or
`interrupted`). A claimed run that is not submitted before process loss is
interrupted rather than replayed. The idle reaper uses the same run/session
identity check and bypasses only active admitted automation runs; browser
connections and `longRunning` do not keep automation alive.

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

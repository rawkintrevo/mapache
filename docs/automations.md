# Scheduled Automations

## Scope and release gate

Scheduled workspace automations are an opt-in product slice. The
`appConfig/automations.enabled` flag remains false until the release canary has
verified scheduling, dedicated runner cleanup, read-only workspace inputs, isolated
outputs, browser management, and ordinary main-session regression. Definitions
can be enabled and run using the workspace’s existing GCS storage and configured
model. Opening the Automations panel never starts or stops a runner.

The product does not provision Filestore, NFS, VMs, VPC infrastructure, or a
standing storage service. Each admitted run uses one deterministic
`auto-{runId}` Cloud Run service and the existing `mapache-api` /
`mapache-runner` identity boundary.

## Data and lifecycle

### Authoritative transition map

| Phase | Authoritative owner | Durable decision |
| --- | --- | --- |
| Schedule / Run now | `automationScheduler.service.js` / `automationRuns.service.js` | Create one immutable queued run; idempotency prevents a second occurrence. |
| Queue / admit | `automationAdmission.service.js` | Hold concurrency and optional main exclusion in one transaction. Main runtime reservation ignores automation sessions and consults only this exclusion. |
| Prepare inputs / start runner | `automationProvisioning.service.js` | Claim one deterministic session/service operation and pin saved workspace, browser-snapshot, credential, and output identities. |
| Execute | `session-runner/lib/automationExecution.service.js` | Claim `executionStartedAt` before one prompt submission; a lost or uncertain claim is interrupted, never replayed. |
| Persist result | runner artifact/checkpoint services | Publish immutable output/transcript pointers only after identity and checksum validation. |
| Clean up | `automationCleanup.service.js` | Finalize truthful persistence state, confirm service absence, then release the admission slot. |
| Recover | `automationReconciliation.service.js` | Retry the same provisioning or cleanup operations; never submit a prompt or invent a parallel transition path. |

Failure handling stays with the phase owner. Provisioning records a stable failed
outcome for cleanup, execution records a normalized terminal outcome, and cleanup
retains capacity when deletion or persistence is uncertain. Reconciliation only
resumes those operations, so duplicate delivery converges on the same operation,
session, service, execution claim, or cleanup.

- Definitions live at `workspaces/{workspaceId}/automations/{automationId}`.
  They are owner-scoped, revisioned, audit-recorded, and normalized by
  `functions/automationDefinitions.service.js`.
- Runs live at `automationRuns/{runId}`. Manual runs use an idempotency key;
  cron occurrences use a deterministic ID. Each run keeps an immutable prompt,
  schedule, timezone, model, resource, and parallelism snapshot.
  `functions/automationValidation.helpers.js` preserves explicit null retry
  metadata, including `retryOfRunId: null` for initial attempts, and omits
  undefined fields. Firestore rejects undefined values before a run can queue;
  enqueue tests use its real serializer without committing database writes.
- The minute scheduler validates the feature flag and schedule occurrence,
  records missed ranges as skipped history, and never creates a second pending
  occurrence for one definition.
- Definitions default to `missedRunPolicy=skip`. The opt-in `latest` policy
  accepts one newest missed occurrence inside `catchUpWindowMinutes` (1 to
  10080, default 1440), preserves the current due occurrence when present,
  and records `trigger=catch_up` with its original scheduled time.
- Admission is transactional. `automationMaxConcurrency` defaults to one;
  lowering it never evicts active runs. `allowParallelWithMain: false` holds an
  explicit main-session exclusion, queues while main is active, rejects main
  Play/Restart/Resize during the exclusion, and wakes when main is paused.
- Provisioning creates only the labeled run service after admission. The
  automation session is not the workspace canonical session, does not claim the
  main sync-writer lease, and is excluded from the user session list and idle
  reaper. Initial browserless submission has its own bounded 60-second control
  deadline because creating the first SDK conversation and selecting its model
  can exceed the five-second shutdown/quiesce deadline. The upstream socket
  allows 75 seconds so the runner remains the earlier timeout authority.
- Stop, child crash, lost completion, duplicate delivery, and restart paths are
  idempotent. Cleanup confirms Cloud Run absence before releasing the admission
  slot. A completion callback cannot cause prompt replay.
- Firestore provisioning workers react to admission and session provisioning
  results; their own claim, attachment, and heartbeat writes do not start more
  workers. Cleanup reacts to run status transitions. Cleanup-error writes are
  retried by the minute reconciler rather than immediately retriggering deletion.
  The reconciler requires the `automationRuns` collection index on `status ASC,
  updatedAt ASC` in `firestore.indexes.json`; deploy it before the worker changes.
  Orphan discovery pages through the configured `SESSION_REGION` (default
  `us-central1`) and filters/rechecks automation labels locally. Cloud Run v2
  [service listing](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services/list)
  accepts neither the wildcard region nor a `filter` query parameter.
  The scheduled recovery Function binds the same GitHub/Google secrets and
  540-second timeout as provisioning because it can resume that work directly.
- Reconciliation checks heartbeat freshness synchronously and only probes runners
  after three minutes without a fresh heartbeat. Probes use the authenticated
  `/runner/health` endpoint. Never use `/healthz`, its trailing-slash variant,
  or a fallback/alias: Cloud Run intercepts the bare reserved path before
  container logging, and the trailing-slash workaround is not supported here.
  See [the permanent endpoint rule](./runtime-containers.md#runner-health-endpoint).
  Failed probes emit structured
  run/session IDs, route, original HTTP status, duration, and a stable error code;
  headers and response bodies are omitted to avoid logging credentials.
  Shutdown preserves an already committed interruption and its reason instead of
  relabeling it as user cancellation.
- Transcript sanitization permits nonnegative integer token counts only in
  known usage fields (including `message.usage.totalTokens`); credential-like
  fields elsewhere remain rejected. This fix requires a rebuilt `pi-chrome`
  image and new runner services; existing services require recreation.
- Artifacts are immutable, sanitized, and written under
  `automation-runs/{runId}/v1/`; the manifest pointer is published only after
  checksum/size verification. Global history returns the snapshot and archived
  transcript metadata without exposing provider credentials.
- Automatic retries default to `retryPolicy=none`. The opt-in `safe` policy
  requires `replaySafe=true`, allows at most two linked attempts after known
  failed outcomes (five minutes, then fifteen minutes), and preserves the
  failed attempt snapshot. Canceled, interrupted, unknown-outcome, and cleanup
  failures never retry; queue contention keeps the retry intent durable.

`GET /api/instances` is the owner-wide active-instance inventory. It merges
persisted main session and automation-run records, reports only
`provisioning`, `running`, `stopping`, or `cleanup-error`, de-duplicates an
automation runner session against its run record, and supports `workspaceId`,
`type`, `status`, `limit` (default 50, maximum 100), and opaque cursor filters.
Its stop target contains only workspace/session/run identifiers; no Cloud Run
lookup, credential, or service secret is exposed. Reconciliation workers remain
the authority for repairing stale persisted records.

The avatar menu's **Running instances** page is intentionally an owner-wide
operational view rather than a second session navigator. It polls the bounded
inventory only while the browser tab is visible, supports workspace/type/status
filters and cursor paging, and displays workspace links, automation history
links, elapsed time, resources, and last heartbeat. Main Stop uses the existing
workspace Pause endpoint; automation Stop uses run cleanup. A cleanup error is
shown as an in-progress/attention state and cannot be force-killed from this
page.

The editor's Recovery section exposes `missedRunPolicy` (`skip` or `latest`), a
1–10080 minute catch-up window, `retryPolicy` (`none` or `safe`), zero to two
maximum retries, and an explicit replay-safe acknowledgement. Safe retries can
repeat publication or sends and use current files on each attempt. Agent MCP
schemas and seeded guidance use these same bounds; revision fencing remains
unchanged. Run history exposes the catch-up scheduled timestamp and retry
family IDs/state/reason alongside the immutable recovery snapshot.

## Automation tools in workspace chat

All managed interactive workspaces (blank and GitHub-backed) and automation
runners receive the image-owned `mapache-automations` MCP and guidance skill.
`session-runner/lib/config.js` enables the private runner broker socket for
managed main sessions as well as automation sessions; `mcpConfig.service.js`
registers the server without replacing user entries, and
`workspaceSkillCatalog.js` selects its guidance.

The token broker and API share `functions/automationAgentAdmission.helpers.js`.
Both require a live admitted session with matching owner, workspace, generation,
and boot. Main sessions additionally match the workspace's current admitted
session/generation/boot, so replacing the main revokes old tokens immediately.
Automation sessions retain independent authority. Tokens remain runner-owned;
tools can only manage definitions, settings, and runs within their own workspace.
The existing product feature gate remains unchanged.

Deploy the `api` and `automationAgentToken` Functions, then rebuild and publish
`pi-chrome`. Existing workspaces need a runner restart/recreation onto the new
image revision to discover the tools and skill; new sessions receive them
automatically. No repository files or per-workspace MCP setup are required.

## Read-only GCS inputs and isolated outputs

The automation MVP reuses the workspace's existing bucket. It needs no prepared
shared-storage descriptor, NFS, new bucket, or Google Drive connection. The UI,
definition service, enqueue service, and provisioning service do not gate on
`sharedStorage.state`. Model selection and owner checks still apply.

`functions/automationStorage.service.js` selects trusted input and an isolated
output directory when the automation session is created. New output folders use
the automation name, run date/time in the automation timezone, and a short run
ID suffix, for example `daily-report-2026-09-22-15-40-50-a1b2c3d4`.
The descriptor is saved on that session so provisioning retries reuse both
paths. For ordinary marked workspaces,
`agentRuntimeWorkspaceFiles` selects the latest committed GCS snapshot. Its
`objects/` prefix mounts at `/workspace` read-only. A workspace without a saved
snapshot starts with empty input; stale legacy files are not restored. Legacy
workspaces use their existing flat prefix. Existing ready shared workspaces use
their recorded `trees/{generation}` prefix, also mounted read-only.

Each automation runner keeps its separate writable
`/automation-output/{uuid}` mount, backed by
`{workspace.storagePrefix}/.mapache-internal/automation-outputs/{folder}/` in
the existing workspace bucket. The runner starts its agent in that directory
and prepends input/output instructions to the automation prompt. Main Agent
sessions mount the shared automation-output root read-only at `/automations`, so
new closed files become available to the main Agent without waiting for cleanup
or workspace synchronization. The main Agent can copy selected files into
`/workspace` when edits are needed. Existing UUID-named output directories also
appear under `/automations/{uuid}` after the main session receives the mount.

Outputs persist independently of runner shutdown and transcript archival. Run
history reports the main-Agent path and GCS location. There is no symlink or
automatic merge into `/workspace`; the `/automations` tree is intentionally
read-only in the main session. Workspace deletion retains its existing storage
cleanup behavior.

Main session creation and restart rebuild the storage bucket and prefix from the
owner-checked workspace record before constructing the `/automations` mount.
Persisted session storage fields are compatibility metadata and cannot override
the owning workspace, preventing a stale descriptor from mounting a sibling
workspace's output root.

Cloud Run v2 volumes use `gcs: {bucket, readOnly, mountOptions}`. Automation
input/output mounts and the main session's `/workspace` and `/automations`
mounts are siblings, because Cloud Run does not support nested mounts.
Directory marker objects make empty prefixes mountable. Snapshot manifests are
checksum- and workspace-validated; saved relative symlinks are materialized using
GCS FUSE's `gcsfuse_symlink_target` metadata when older snapshots contain only the
manifest entry. Ordinary input files are neither copied nor rewritten. GCS FUSE
presents uniform 0755 modes, not the original per-file permission bits.

`automation-readonly-gcs-v1` tells the runner to skip workspace download, restore,
git checkout/branch preparation, upload, and deletion reconciliation. Startup
checks for FUSE mounts, rejects a writable input, and probes writable output.
Private agent state, credentials, Chrome profiles, and seeded skills stay outside
the source mount. The automation keeps its existing independent runtime authority
and never acquires the main sync-writer lease.

### One-way Chrome profile inheritance

Chrome website-session inheritance uses a separate immutable seed namespace under
`{workspace.storagePrefix}/.mapache-internal/chrome-profile-seeds/v1/`. The
interactive workspace runner is the only publisher. It flushes the filesystem,
captures the profile with the reviewed transient-path filter, compares a complete
directory signature before and after the tar capture, and retries a bounded number
of times when Chromium is still changing state. Cookies, local storage, IndexedDB,
SQLite databases, and their WAL files remain eligible; caches, downloads, crash
state, locks, sockets, and debugging endpoints do not. An immutable archive and
descriptor are uploaded first; `current.json` advances only after both are
complete. The descriptor records the schema, owning workspace, seed version,
object generation, checksum, capture time, and browser compatibility metadata.

When an automation is admitted, Functions selects the workspace's last complete
published descriptor without contacting the live browser. Periodic/final
publication and the protected explicit snapshot route are separate refresh
operations, so a changing profile cannot block ordinary startup. The selected
descriptor is validated and pinned to the run and session before Cloud Run
provisioning; retries reuse that exact version.
A workspace with no published profile is explicitly marked `fresh/no_seed`.
Object, checksum, ownership, or compatibility failures are explicit and
never silently downgrade an inherited run to a fresh profile. Seed versions are
retained while referenced by runs and the runner keeps a bounded recent history;
workspace deletion removes the internal namespace with the workspace storage.

The automation runner downloads and verifies only its pinned descriptor, restores
into its private `/var/lib/mapache/runtimes/{runId}/chrome/profile` before
Chromium starts, and never publishes its modified profile. Run history exposes
only safe initialization state (mode, reason, capture time, and age), never the
archive path, URL, cookies, or site storage. A copied browser session can still
expire or be rejected by a site and may require signing in again in workspace
Chrome before starting a new run.

Private automation and Google token broker sockets use
`session-runner/lib/unixSocketPath.helpers.js` to bound pathname byte length.
Paths longer than 100 bytes resolve under a private `/tmp/mapache-ipc-{sha256}`
directory using a hash of the full original path, keeping runtime and broker
identities distinct. The directory remains 0700 and each socket 0600. This is
required for scheduled run IDs, whose ordinary runtime paths exceed Unix socket
limits. Rebuild and publish `pi-chrome` for this fix; existing services require
restart/recreation to receive the new socket configuration.

Automations can run alongside main and each other. They see saved input selected
at admission/provisioning, not unsaved main-session edits. They cannot overwrite
one another's outputs through these mounts. This is a filesystem write boundary,
not a new IAM sandbox: the mandated runner service account keeps its existing
GCS permissions. Direct cloud API access is still governed by existing account
and application authorization.

The legacy shared-storage preparation/recovery endpoints remain maintenance
surfaces for previously configured workspaces; they are not part of automation
setup. The Automations panel describes separate outputs and provides no storage
provisioning or revalidation action. Enable/Run now are gated only by model and
pending mutation/loading state. Missing models offer **Choose model**, which opens
that definition's editor. `AutomationModelPicker.jsx` provides provider/model
dropdowns directly in `AutomationEditor.jsx`, without starting the main session.
Both IDs must be present before Enable/Run now become usable; changing provider
clears the model. Disabled drafts can still be saved. Existing workspace defaults
populate the draft, and the selected pair is saved on the automation definition
through the existing revisioned API. Refresh preserves an open draft.

The picker uses `src/config/automationModelCatalog.json`, a labels/IDs-only export
of the runner's pinned `@earendil-works/pi-ai` catalog. Regenerate it with
`npm run generate:automation-models` when updating the Pi SDK pin in
`session-runner/upstream/pi-web-ui/manifest.json`; a frontend test checks version
alignment. Saved unknown IDs remain selectable, and custom IDs can be entered for
new models or providers already configured in the runner. The catalog does not
verify credentials or provider account access; execution uses existing saved
credentials. Interactive Agent model selection remains upstream-owned.

## Cost and recovery accounting

Cloud Storage charges live and soft-deleted bytes. At the current published
`us-central1` Standard regional rate of `$0.000027397/GiB-hour`, one GiB kept
for the full seven-day recovery window costs approximately `$0.00460270`:
`1 × 168 × 0.000027397`. HNS Standard operations are currently `$0.0065 per
1,000 Class A` and `$0.0005 per 1,000 Class B` operations. For a measured
fixture with 1 GiB retained, 10 Class A operations, and 20 Class B operations,
the seven-day storage plus operation example is approximately `$0.00467770`
before Cloud Run, network, or free-tier adjustments. Prices must be refreshed
from the [Cloud Storage pricing page](https://cloud.google.com/storage/pricing)
when a release records actual harness measurements; the live harness accepts
the current rate explicitly and writes byte/operation evidence.

Soft delete is object recovery, not a point-in-time workspace backup. The
operator recovery service requires all runners stopped and a maintenance
reservation, lists only retained generations, verifies the selected generation
and hashes, and writes a separate `sharedStorageRecovery` tree/pointer. It never
automatically switches the active `sharedStorage` pointer or rolls back a live
workspace. There is no immediate purge guarantee after teardown; residual
retained bytes and their `recoverableUntil` time must be recorded.

## Release and rollback

Stage Firestore rules/indexes and worker consumers before producer/API routes,
build and publish the immutable `pi-chrome` image before the new automation path or
the Automations UI, then deploy Functions before Hosting with explicit project
flags. Keep the feature flag off through deployment and enable it only for the
canary. Record the image digest, exact commands, mount configuration,
compatibility evidence, and storage/API cost measurements.

```bash
npm run check
gcloud builds submit session-runner --config session-runner/cloudbuild.pi-chrome.yaml --project pi-agents-cloud
firebase deploy --only firestore,functions,hosting --project pi-agents-cloud
```

Rollback disables new scheduling/admission while Stop, history, and cleanup
remain available. Drain admitted runs, confirm child services are absent, and
never point a live shared workspace at a stale legacy archive. Existing
workspaces are not migrated automatically.

## Verification surfaces

- Local deterministic lifecycle evidence: `node scripts/automation-lifecycle-harness.mjs run --project pi-agents-cloud`.
- Real two-runner GCS FUSE evidence: `node scripts/automation-storage-live-harness.mjs run --project pi-agents-cloud --storage-rate-usd-per-gib-month RATE`.
- Browser combined management/history evidence: `e2e/qa/cases/automation-management.json` through Chrome DevTools-assisted QA. The signed-in shell exposes one Automations entry in the topbar and More menu; the resulting page renders definitions and owner-wide run history together.
- Backend, runner, frontend, build, and documentation checks: `npm run check` and the focused commands in [Testing](./testing.md).

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

- Definitions live at `workspaces/{workspaceId}/automations/{automationId}`.
  They are owner-scoped, revisioned, audit-recorded, and normalized by
  `functions/automationDefinitions.service.js`.
- Runs live at `automationRuns/{runId}`. Manual runs use an idempotency key;
  cron occurrences use a deterministic ID. Each run keeps an immutable prompt,
  schedule, timezone, model, resource, and parallelism snapshot.
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
  reaper.
- Stop, child crash, lost completion, duplicate delivery, and restart paths are
  idempotent. Cleanup confirms Cloud Run absence before releasing the admission
  slot. A completion callback cannot cause prompt replay.
- Firestore provisioning workers react to admission and session provisioning
  results; their own claim, attachment, and heartbeat writes do not start more
  workers. Cleanup reacts to run status transitions. Cleanup-error writes are
  retried by the minute reconciler rather than immediately retriggering deletion.
  The reconciler requires the `automationRuns` collection index on `status ASC,
  updatedAt ASC` in `firestore.indexes.json`; deploy it before the worker changes.
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

## Read-only GCS inputs and isolated outputs

The automation MVP reuses the workspace's existing bucket. It needs no prepared
shared-storage descriptor, NFS, new bucket, or Google Drive connection. The UI,
definition service, enqueue service, and provisioning service do not gate on
`sharedStorage.state`. Model selection and owner checks still apply.

`functions/automationStorage.service.js` selects trusted input and a random UUID
output directory when the automation session is created. The descriptor is saved
on that session so retries reuse both paths. For ordinary marked workspaces,
`agentRuntimeWorkspaceFiles` selects the latest committed GCS snapshot. Its
`objects/` prefix mounts at `/workspace` read-only. A workspace without a saved
snapshot starts with empty input; stale legacy files are not restored. Legacy
workspaces use their existing flat prefix. Existing ready shared workspaces use
their recorded `trees/{generation}` prefix, also mounted read-only.

Each run's `/automation-output/{uuid}` is a separate writable GCS mount backed by
`{workspace.storagePrefix}/.mapache-internal/automation-outputs/{uuid}/` in the
existing workspace bucket. The runner starts its agent in that directory and
prepends input/output instructions to the automation prompt. Closed output files
persist independently of runner shutdown, transcript archival, and the main
session. Run history reports the output path and GCS location. Automatic merging,
output downloads in the file browser, and a reconciliation service are follow-up
work. Workspace deletion retains its existing storage cleanup behavior.

Cloud Run v2 volumes use `gcs: {bucket, readOnly, mountOptions}`. The input and
output mounts are siblings, because Cloud Run does not support nested mounts.
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

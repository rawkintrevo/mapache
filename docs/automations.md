# Scheduled Automations

## Scope and release gate

Scheduled workspace automations are an opt-in product slice. The
`appConfig/automations.enabled` flag remains false until the release canary has
verified scheduling, dedicated runner cleanup, shared-storage behavior, browser
management, and ordinary main-session regression. A disabled definition may be
saved, but it cannot be enabled or run before its workspace has ready shared
storage. Opening the Automations panel never starts or stops a runner, and
preparing storage never stops the main workspace automatically.

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
- Artifacts are immutable, sanitized, and written under
  `automation-runs/{runId}/v1/`; the manifest pointer is published only after
  checksum/size verification. Global history returns the snapshot and archived
  transcript metadata without exposing provider credentials.

## Shared GCS FUSE contract

Automation storage preparation is a paused-workspace migration. The backend
creates or reconciles one private regional `us-central1` Standard bucket with
hierarchical namespace, uniform bucket-level access, public-access prevention,
Object Versioning disabled, and a seven-day (`604800` second) soft-delete
policy. The existing bucket owner labels and project/workspace identity are
validated before IAM reconciliation. The runner receives only a backend-owned
bucket/generation descriptor; browser payloads cannot choose a bucket.

The active `pi-chrome` revision mounts the exact `trees/{storageGeneration}`
prefix using the gen2 `gcsfuse.run.googleapis.com` CSI driver with:

```text
only-dir=trees/{storageGeneration}
metadata-cache-ttl-secs=0
stat-cache-max-size-mb=0
type-cache-max-size-mb=0
implicit-dirs=true
log-severity=warning
```

The ready marker is published last. Close-to-open visibility is the supported
consistency expectation; the last writer wins when two runners write the same
file, and ESTALE/managed mount errors must be surfaced rather than retried as
silent success. The runtime does not promise distributed locks, native chmod,
or fsync-only durability. Supported Git flows keep repository metadata in the
private runner path (`GIT_DIR`/`GIT_WORK_TREE`); `.git`, browser profiles,
credentials, caches, and agent state never enter the shared mount. Submodules
and nested-repository migration remain explicit unsupported cases.

Per-workspace bucket names and prefixes are not an IAM tenant sandbox. The
mandated runner principal can read any bucket to which it is granted. API,
agent-tool, and Firestore owner checks remain the security boundary; anonymous
and unprivileged bucket reads must fail.

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
build and publish the immutable `pi-chrome` image before storage preparation or
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
- Browser management/history evidence: `e2e/qa/cases/automation-management.json` through Chrome DevTools-assisted QA.
- Backend, runner, frontend, build, and documentation checks: `npm run check` and the focused commands in [Testing](./testing.md).

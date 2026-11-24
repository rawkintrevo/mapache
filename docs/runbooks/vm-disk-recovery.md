# VM disk-full and zone-loss runbook

This runbook is for the opt-in Compute Engine VM backend only. It is an
operator diagnostic and recovery boundary, not an automatic migration or a
permission to delete a retained disk. Use the explicit `pi-agents-cloud`
project on every cloud command. The authenticated runner health endpoint is
`/runner/health`; `/healthz` and `/healthz/` are not valid endpoints.

## Safety gates

Before taking action, confirm all of the following:

- The workspace is an explicitly admitted Compute Engine runtime with the
  expected owner and generation.
- No migration fence, authority switch, rollback, or active backup/restore
  operation is in progress.
- The operation status and read-only backup inventory have been captured.
- The exact disk name, zone, instance name, and ownership labels came from the
  backend descriptor or an owner-scoped operation receipt.

Never start a second VM because a first start is slow or its provider result is
uncertain. Inspect the existing lifecycle operation first. Never delete a disk
or snapshot when ownership, generation, attachment state, or provider
operation state is unknown.

## Evidence collection

Record the workspace ID, operation ID, generation, and UTC time. The owner can
read a lifecycle operation through the authenticated VM API:

```text
GET /workspaces/{workspaceId}/operations/{operationId}
```

The response is expected to identify the current phase, `phaseTimingsMs`,
`phaseStartedAtMs`, and any bounded `failedPhase`, `lastError`, and
`lastErrorAtMs`. Capture the read-only
`vmBackupInventoryReports_v2/{workspaceId}` report as well; it must not be
interpreted as cleanup authorization.

For an operator with the required IAM role, inspect only the exact resources
already recorded by the backend:

```bash
gcloud compute disks describe DISK_NAME \
  --zone=ZONE \
  --project=pi-agents-cloud \
  --format='yaml(name,id,status,sizeGb,users,labels)'

gcloud compute instances describe INSTANCE_NAME \
  --zone=ZONE \
  --project=pi-agents-cloud \
  --format='yaml(name,id,status,disks,networkInterfaces,labels)'
```

A missing result is evidence that the resource is absent, not evidence that a
replacement is safe. Preserve the source operation and disk records until the
owner and generation checks are complete.

## Disk-full procedure

1. Stop repeated start/replace attempts. Read the lifecycle operation and
   capture its failed phase and timings.
2. If the runner is reachable, stop application writers through the existing
   authenticated control path. If it is not reachable, keep lifecycle
   admission held and record `quiesce_unreachable_delete_required`; do not
   report a graceful shutdown.
3. Confirm whether the exact retained disk is attached to the expected VM. An
   attached disk, a foreign attachment, or an unknown attachment blocks
   deletion and restore.
4. Measure guest free space through the supported runtime diagnostic when it is
   available. If it is unavailable, report headroom as unknown. Provisioned
   disk size is not a guest free-space measurement.
5. After confirming the runtime is stopped and no migration fence or active
   operation exists, an operator may expand the exact detached disk with:

   ```bash
   node scripts/vm-resize-disk.mjs \
     --project=pi-agents-cloud \
     --workspace=WORKSPACE_ID \
     --owner=OWNER_UID \
     --generation=GENERATION \
     --size-gb=NEW_SIZE_GIB \
     --confirm-resize
   ```

   The command verifies owner and generation, refuses shrink, attached or
   foreign storage, polls the named Compute operation, and confirms the new
   provider capacity. It does not resize the guest filesystem or release
   writer admission.
6. After provider expansion, use a separately selected private Linux
   maintenance VM. Install the checked-in remote helper and its dependencies
   under `/opt/mapache-maintenance` on that VM, verify its Compute instance ID
   and strict-host-key IAP access, then run the guarded filesystem action:

   ```bash
   node scripts/vm-grow-filesystem.mjs \
     --project=pi-agents-cloud \
     --workspace=WORKSPACE_ID \
     --owner=OWNER_UID \
     --generation=GENERATION \
     --size-gb=NEW_SIZE_GIB \
     --maintenance-instance=MAINTENANCE_INSTANCE \
     --maintenance-id=MAINTENANCE_INSTANCE_ID \
     --confirm-grow
   ```

   The action rechecks the stopped runtime, migration/backup fences, exact
   owner-labelled disk and provider capacity; attaches only that disk
   read/write to the exact maintenance instance; runs `e2fsck -pf` and
   `resize2fs`; mounts it read-only for a marker and `statfs` check; and
   detaches it before returning bounded timing and capacity evidence. It
   refuses a mounted disk, non-ext4 filesystem, marker mismatch, public
   maintenance instance, or identity mismatch. It never starts the workspace
   VM, changes Firestore authority, or releases writer admission.
7. Start the workspace only through its normal lifecycle operation and verify
   the exact disk identity, mount, ownership, and authenticated
   `/runner/health` readiness before releasing admission. The health response's
   bounded `disk` projection must report the grown guest capacity; provider
   size alone is not sufficient. Record the attach, filesystem, mount, and
   health timings in the operation evidence. Do not substitute a blind VM
   restart for a resize.

If the disk cannot be made usable, a restore may proceed only from a verified,
owner-matched backup to a fresh target disk. An isolated operator proof can be
run only with a pinned image and explicit confirmation:

```bash
node scripts/vm-backup-recovery-proof.mjs \
  --project=pi-agents-cloud \
  --workspace=WORKSPACE_ID \
  --owner=OWNER_UID \
  --backup=BACKUP_ID \
  --runner-image=PINNED_SESSION_RUNNER_DIGEST \
  --confirm-recovery
```

The proof uses a deterministic fresh disk/VM, IAP SSH, authenticated
`/runner/health`, and the bounded `/runner/recovery-digest` endpoint. It records
provider restore, VM startup, runner readiness, RPO, and RTO timings, then
requires exact detached-resource cleanup. It fails closed when the backup has
no source file digest to compare, so a successful VM boot is not by itself a
recovery claim. It does not publish a route, change Firestore authority, or
delete the source disk or snapshot. Do not run it against a production
workspace while the rollout flag is disabled; use a disposable backup fixture.

The durable recovery controller has the same cleanup invariant: a failed digest
or runtime verification is not terminal until the adapter confirms both the
operation-owned recovery VM and target disk are gone. A failed cleanup remains
retryable and keeps the source backup retained.

The durable restore controller is wired to the isolated production adapter.
Before enabling an opted-in restore, configure a dedicated tagged gateway
revision in `VM_BACKUP_RECOVERY_GATEWAY_HOST` (the hostname must begin with
`backup-recovery---` and end in `.run.app`) and an immutable `@sha256:` value in
`SESSION_RUNNER_IMAGE`. Missing or unpinned configuration fails before any
Firestore, Compute, or route mutation. A configured restore stages only
`vmBackupRecoveryRuntimes_v2`, `vmBackupRecoveryCredentials_v2`, and a
`recoveryOnly` gateway route; it never reuses the source workspace runtime or
authority. The runner leases through `vmBackupRecoveryControl_v2`, and the
gateway permits only authenticated `/runner/health`,
`/runner/recovery-digest`, and shutdown. The source disk, snapshot, and normal
workspace authority remain retained throughout verification.

The owner-facing reservation request is:

```text
POST /workspaces/{workspaceId}/backup
{"requestId":"...","backupId":"...","expectedGeneration":N}
```

Poll `GET /workspaces/{workspaceId}/backup` for the bounded recovery phase and
report. A successful recovery requires matching source/target file and
runtime-state digests, authenticated readiness, and measured RPO/RTO. A failed
verification cannot become terminal until the exact recovery VM and restored
disk are confirmed absent; uncertain cleanup remains retryable with the source
backup retained. The durable controller also fails closed when either source
digest is missing; a target-only digest cannot satisfy the recovery check.

## Cost evidence

The backup inventory's storage estimate is not a complete cost meter. When a
release review needs a numeric monthly worksheet, capture current usage and
rates from the billing/operations sources and run the local, read-only helper:

```bash
node scripts/vm-cost-report.mjs \
  --project=pi-agents-cloud \
  --input=WORKSHEET_JSON \
  --output=NEW_COST_REPORT_JSON
```

The worksheet requires explicit retained-disk, snapshot, compute, gateway
forwarding/processing, NAT hours/processing, egress, logging/operations,
migration-overlap, and failed/orphaned-resource usage and rates. Missing values
fail closed; only explicitly supplied zeroes are zero. The helper does not make
cloud calls or change resources. Check the report's usage/rate timestamps and
source before using `totalMonthlyUsd`; it is numeric input evidence, not a
replacement for an actual billing export.

Future crash-consistent backups made while a VM is active carry a source
digest captured immediately before the snapshot request. Treat that digest as
the comparison input, not as application-consistency proof: the snapshot may
still include writes that race the probe. Backups made while stopped, or when
the authenticated source probe is unavailable, remain explicitly undigested
and must not be reported as file-verified recovery.

## Zone-loss procedure

1. Treat a zonal disk and its VM as unavailable until Compute inspection and
   provider-operation reconciliation establish otherwise. Do not delete the
   disk or clear the lifecycle operation merely because the zone is unhealthy.
2. Confirm the last verified backup and its source generation. An unverified,
   foreign, migration-associated, or provider-pending snapshot cannot be used
   for recovery or cleanup.
3. A zonal retained disk cannot simply be attached to a VM in another zone.
   Recovery requires a verified snapshot restore to a fresh target in the
   chosen zone, followed by file/runtime digest verification and authenticated
   `/runner/health` readiness.
4. Use the isolated recovery adapter only after the dedicated gateway and
   pinned-image configuration checks pass. If they do not, record
   `vm_zone_loss_recovery_configuration_unavailable`, retain the source disk
   and verified backups, and do not create a target disk or VM.
5. Once the runtime verifier supplies matching file/runtime digests and
   measured RPO/RTO, use the migration authority and rollback gates before
   exposing a replacement route. A successful provider disk-create operation
   alone is never a successful recovery.

## Do not close the incident as recovered when

- the lifecycle phase is still pending or has an unknown provider operation;
- the disk is attached to an unexpected instance or has unverifiable labels;
- the latest backup is outside the declared RPO or has not been verified;
- only Compute `RUNNING` is known and runner readiness/filesystem evidence is
  absent; or
- the action would require deleting source data, a retained disk, a migration
  disk, or a snapshot whose ownership/retention guard has not passed.

The current safe terminal states are `recovered` only after the complete
runtime evidence exists, or `blocked-with-source-retained` with the failed
phase/error recorded. A blocked state is actionable evidence, not a reason to
retry blindly.

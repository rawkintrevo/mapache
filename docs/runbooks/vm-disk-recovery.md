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
6. After the provider expansion, complete the guest filesystem check and
   verify the exact disk identity, mount, ownership, and authenticated
   `/runner/health` readiness before releasing admission. Record the measured
   attach/mount/health timings in the operation evidence. Do not substitute a
   blind VM restart for a resize.

If the disk cannot be made usable, a restore may proceed only from a verified,
owner-matched backup to a fresh target disk. The current restore controller
requires a runtime/file verifier; until that adapter is wired to an isolated
fresh VM, the safe outcome is
`vm_restore_runtime_verifier_unwired`, with the original disk and backup
retained.

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
4. The current production adapter stops at the durable restore receipt because
   fresh-VM runtime verification is not yet wired. Record
   `vm_zone_loss_restore_verifier_unwired`, retain the source disk and verified
   backups, and escalate for the isolated recovery rehearsal.
5. Once a future runtime verifier supplies matching file/runtime digests and
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

# VM Workspaces

This page is the active contract for the disposable Compute Engine workspace
backend introduced by #605. Firebase Hosting, Auth, Firestore, Cloud Storage,
and Cloud Functions remain the control plane. The VM feature is disabled until
the isolated proof and release gates in this page have passed.

Remote-host libvirt workspaces are a separate provider contract. See
[Remote-host VM workspaces](./remote-vm-workspaces.md). The records and
lifecycle described here for Compute Engine must not be applied to a remote
host, and a remote-host error must not fall back to this provider.

## Decision summary

Each managed workspace is one logical machine with a stable workspace ID and a
single retained zonal Persistent Disk. Compute is disposable: normal pause
deletes the VM and its auto-delete boot disk, while the data disk remains
attached to no writer. A replacement creates a new boot disk and VM, verifies
the data-disk identity, and attaches that same disk read/write. A workspace
never silently changes from a stored VM provider back to a stale Cloud Run
checkpoint.

The default region is `us-central1`; the initial proof zone is `us-central1-a`.
The initial machine preset is `e2-standard-2`, with a `pd-balanced` data disk
starting at 64 GiB and growing only after an explicit validated request. A
regional or multi-zone disk is a later availability decision, not an implicit
fallback. We do not introduce a standing cluster, NFS server, or shared
ext4 attachment.

`functions/runtimeProvider.helpers.js` owns the versioned descriptor and
workspace/owner identity checks. `functions/computeEngine.service.js` owns
Compute Engine REST operations, ownership labels, retained-disk attachment,
boot-disk deletion, and the Docker startup script. `functions/runtimeProvider.service.js`
dispatches lifecycle operations to the stored provider. `VM_WORKSPACE_RUNTIME_ENABLED`
only controls new workspace admission; it cannot change an already stored
descriptor.

## Trusted runtime descriptor

Managed workspace and session records may contain:

| Field | Contract |
| --- | --- |
| `version` | `1`; unknown versions fail closed. |
| `backend` | `cloud-run`, `compute-engine`, or retained `ssh`. |
| `workspaceId`, `ownerUid` | Backend-authored identity; must match the document and authenticated caller. |
| `region`, `zone` | Backend-selected location. |
| `generation` | Monotonic writer/access generation. |
| `dataDiskName` | Deterministic backend-owned name; never accepted from the browser. |
| `instanceName` | Generation-specific disposable VM name. |
| `gateway.baseUrl` | HTTPS origin only; no caller-supplied upstream address or credentials. |
| `desiredConfigVersion` | Machine configuration revision that must be applied before agent launch. |
| `state` | Provider state, reconciled from Compute Engine rather than inferred from a request timeout. |

Legacy records without a provider descriptor remain Cloud Run records. A record
that advertises a provider version but has a missing or invalid descriptor is a
visible error; no fallback writer is launched.

## Durable path and lifetime contract

The VM startup script uses Docker directly and never uses the deprecated
container declaration path. It formats a disk only when the create operation
proved that the disk is new, then mounts it. An existing disk must already have
the expected filesystem and marker; a missing marker, wrong owner, wrong
workspace, or unexpected populated root stops startup.

| Data | Container path | Backing | Lifetime | Writer |
| --- | --- | --- | --- | --- |
| Workspace and `.git` | `/workspace` | retained disk | workspace lifetime | main VM only |
| User HOME and local tools | `/root` | retained disk | workspace lifetime | main VM only |
| Agent history, transcripts, UI state, MCP selection | `/var/lib/mapache/agent` | retained disk | workspace lifetime | admitted runtime |
| Chromium profile | `/var/lib/mapache/chrome/profile` | retained disk | workspace lifetime | one interactive browser |
| Broker-materialized credentials | `/var/lib/mapache/credentials` | retained disk with managed refresh/revocation | selected binding lifetime | control plane/runtime |
| Uploads | `/uploads` and workspace files | retained disk | workspace lifetime | authenticated upload or workspace process |
| Caches | `/var/cache/mapache` | retained disk, disposable contents | workspace lifetime | runtime-local |
| PID files, sockets, locks | runtime-specific subdirectories | recreated on boot | process lifetime | one VM |
| Boot image, Docker layers, logs | boot disk / logging | disposable or exported logs | VM lifetime / retention policy | VM service account |
| Backups and immutable outputs | Cloud Storage / snapshots | separate backup/output policy | configured retention | control plane |

Normal start, pause, and replacement do not serialize HOME or WORKSPACE to
Cloud Storage. Checkpoint and bundle readers remain available for migration and
recovery, but are not the VM lifecycle protocol. The filesystem is POSIX and
therefore preserves native locks, renames, modes, symlinks, dirty Git state,
SQLite files, and package trees.

Owner-wide tools remain owner-scoped rather than being attached read/write to
multiple VMs. Until a native owner-wide tool volume exists, installation
sharing is explicit through the existing broker/storage contract; the VM path
does not mount one ordinary ext4 filesystem into two workspaces.

## Access, identity, and routing

Runner, Chrome, terminal, preview, upload, and WebSocket traffic enters through
the authenticated gateway origin recorded in the trusted descriptor. The VM has
no public runner, Chrome, terminal, or debug port. The gateway authorizes the
Firebase owner/access policy and the current runtime generation before routing;
stale cookies and old generations are rejected. VM IP changes and replacement
are handled by updating the backend-owned gateway target and reconnecting with
fresh access material.

The Compute Engine runtime identity is
`mapache-runner@pi-agents-cloud.iam.gserviceaccount.com`. It receives only the
runtime scopes needed for logging, monitoring, and the runner's approved
read-only image/object access. `mapache-api@pi-agents-cloud.iam.gserviceaccount.com`
owns provisioning and requires `roles/iam.serviceAccountUser` on the runner
identity. The runner cannot create/delete arbitrary Compute Engine resources or
read another workspace's disk. Every instance and disk carries immutable
`mapache-owner-uid`, `mapache-workspace-id`, `mapache-operation-id`, and
`mapache-runtime-provider` labels; cleanup refuses foreign labels. Compute
Engine label values are deterministic lowercase-safe projections of the full
owner/workspace/operation identifiers (with a bounded hash suffix when needed);
the full identifiers remain authoritative in Firestore, the disk marker and
instance metadata. This keeps Firebase's mixed-case workspace IDs valid for
Compute Engine without weakening ownership checks.

The canonical health contract remains `/runner/health`, with a functional
agent/readiness check in addition to HTTP readiness. No alternate health path
is part of this design.

## Automation and workspace requests

An external scheduler owns the wake-up: it admits the selected workspace,
starts its VM if stopped, applies the latest managed configuration, waits for
functional readiness, and runs the task on that machine without a browser.
Automation work uses a separate process/runtime identity, read-only source
views where required, and isolated output prefixes. It never attaches an
ordinary writable ext4 disk to two VMs. `http_ticket` requests continue in the
target machine's normal runtime with directional grants, stable source/target
IDs, durable results, and no transfer of target credentials to the caller.

Queue/admission records and generation fencing survive retries, worker loss,
uncertain acknowledgements, and VM replacement. An uncertain external side
effect is not replayed automatically. Pause waits for admitted work according
to the existing exclusion policy; it does not silently kill a scheduled task.
Usage records distinguish active VM time, retained disk, and background work.

## Configuration contract

The control plane stores desired machine configuration separately from the
runtime's applied version. Supported centrally managed selections include Pi
auth/config, environment entries, MCP definitions, Google Workspace bindings,
gateway assignment, resource preset, data-disk growth, idle policy, and
schedule. Secrets stay in backend-owned stores; Firestore/client DTOs contain
IDs and redacted status only. The latest desired revision is applied before Pi
or MCP launch on every start/replacement. A process-restart or VM-recreate
change is reported as pending and is not forced through an active task.

Saving while stopped updates desired state without starting compute. The workspace
edit modal exposes the safe IDs, resource preset, disk growth, description, and
idle policy; it never accepts a disk name, secret, zone, or machine identity.
Stale expected-version saves fail with a conflict. Unmanaged local files/settings
remain on the retained filesystem. Disk shrink, arbitrary disk identity, owner,
zone, and unsupported machine-family transitions are separate migrations, not
ordinary modal edits.

Direct VM uploads use the same short-lived, session-scoped browser access token
as the terminal and browser URLs. The token stays in the in-memory upload URL;
the runner writes bounded chunks to a temporary file and atomically renames the
file into `/uploads` after size/checksum and create-only checks pass.

## Migration and recovery state machines

Inventory is read-only and accounts for blank, GitHub, shared-storage,
checkpoint, bundle-v1, HOME archive, owner-tool, large-file-v1, running, and
failed-stop workspaces. SSH-backed machines are reported unsupported for
automatic migration. The importer writes a new owned disk using bounded
streams, a journal, source generations, create-only destination writes, and a
ready marker. It never changes authority or deletes the source.

Cutover is:

```text
preflight -> reserve/freeze -> quiesce writers -> final capture
          -> import/verify -> compare-and-swap authority
          -> validate VM -> release admission
```

Every transition is resumable and records the source generation, destination
disk/generation, operation owner, progress, and blocker. Before destination
writes, rollback restores source authority only after every destination writer
stops. After destination writes, rollback requires a verified reverse export or
remains visibly blocked; flipping back to an old checkpoint is never accepted.
Sources and backups remain through the rollback window. No source is deleted
because an import job merely reported success.

Backups are separate from retained storage. The selected initial policy is
daily crash-consistent snapshots with a 14-day retention target, plus an
operator-rehearsed restore to a fresh disk/VM. Application-consistent captures
are required before a migration cutover or any operation that claims a tighter
RPO. Cleanup first fences admissions, confirms compute absence and disk
detachment, and only then applies the explicit tombstone/backup policy.

## Cost model and guardrails

These are planning estimates, not measured usage. The pricing references were
checked on 2026-11-23 and must be refreshed before production approval:

- Persistent Disk Balanced in Iowa is listed at `$0.10/GiB-month`; 64 GiB is
  therefore approximately `$6.40/month` while retained, before snapshots.
- Standard snapshots are listed at `$0.065/GiB-month`; a 64 GiB fully changed
  snapshot is an upper-bound planning value of `$4.16/month`, while incremental
  snapshots are normally lower.
- A forwarding rule is listed at `$0.025/hour` for the first five global rules;
  regional gateway/data-processing, NAT, egress, logging, and TLS products are
  separate line items.
- VM compute is selected by machine type and active seconds. The release
  worksheet must use the current `e2-standard-2` us-central1 rate and observed
  cold-start/active-hour distribution rather than embedding an unverified
  number in application code.

The monthly worksheet is:

```text
active VM hours * current machine rate
+ provisioned data GiB * disk rate
+ changed snapshot GiB * snapshot rate
+ gateway forwarding rules + gateway processing
+ NAT/static IP/logging/egress
+ migration overlap + failed/orphaned resource allowance
```

Hard controls are quotas, admission concurrency, disk-size ceilings, labels,
orphan reconciliation, and an off-by-default feature flag. Budgets and alerts
are visibility, not a hard spend cap. The operator dashboard must expose disk
headroom, backup age/failures, startup stage timings, stranded resources, and
actual compute/storage/network cost.

Pricing references: [Compute Engine pricing](https://cloud.google.com/products/compute/pricing),
[Google Cloud block storage pricing](https://cloud.google.com/products/block-storage),
[Cloud Load Balancing pricing](https://cloud.google.com/load-balancing/pricing), and
[Compute Engine snapshot behavior](https://docs.cloud.google.com/compute/docs/disks/snapshots).

## Simplification audit

| Existing mechanism | VM decision | Removal gate |
| --- | --- | --- |
| Main HOME/workspace tar/checkpoint restore and shutdown upload | Replace with retained paths; keep readers for migration/recovery | Persistence and rollback fixtures pass |
| Large-file pointers and mandatory GCS upload mount | Replace with bounded resumable disk uploads; retain old readers | #622 tests pass for migrated VM paths |
| Chromium profile archive/restore, tint2 dependency, and layered restart policy | Open profile in place; minimal Openbox/Xvfb/VNC; one supervisor; verify sandbox and shared memory | #621 browser matrix passes |
| Private Git seed/reconstruction for ordinary POSIX main worktree | Keep `.git` in the retained worktree; preserve isolated automation Git | Migration comparison and dirty-history tests pass |
| GCS FUSE mode/lock/cache/polling workarounds | Remove only on VM path; preserve polling for remote clients and historical readers | No active workspace depends on removed path |
| Cloud Run revision/min-instance/probe workarounds | Keep for legacy/unsupported records; stop adding them to VM path | #620 rollback window expires |
| Overlapping process supervisors | One container/VM startup owner and one browser supervisor | Crash/restart tests pass |

## Release and verification gates

The current branch includes local contract/fixture coverage for descriptor
validation, Compute Engine request construction, ownership checks, retained-disk
identity, and the VM runner path. The live gates still require an isolated
`pi-agents-cloud` fixture (never a real user workspace): delete/recreate cycles,
hard loss, attach failure, disk-full, zone recovery, real authenticated
gateway/WebSockets, browser/upload QA, backup restore, migration formats,
central configuration, automation wake-up, machine-to-machine requests, and
resumable cohort reconciliation.

Rollout order is fixture -> canary -> bounded cohort -> reconciliation ->
rollback-window expiry -> legacy retirement. The parent feature flag remains
off until numeric thresholds for integrity, startup, gateway reconnect, cost,
and failure recovery are recorded. `pi-n64`, user-provided SSH machines, and
unrelated frontend/agent rewrites remain outside automatic migration.

## Related owners

- Provider contract: `functions/runtimeProvider.helpers.js`, `functions/runtimeProvider.service.js`
- Compute lifecycle: `functions/computeEngine.service.js`
- Session admission/lifecycle: `functions/sessionLifecycle.service.js`, `functions/provisioning.worker.js`, `functions/workspaceSessionReservation.service.js`
- Runner durable paths: `session-runner/lib/config.js`, `session-runner/lib/retainedDiskStorage.js`, `session-runner/lib/workspace.js`
- Browser simplification: `session-runner/lib/chromeDesktop.js`
- Existing migration/recovery readers: `functions/workspaceStorageMigration.service.js`, `functions/workspaceStorageBackup.service.js`, `session-runner/maintenance/`
- Existing automation/request contracts: `functions/automation*.service.js`, `functions/workspaceRequest*.service.js`

# VM Workspaces

This page is the active contract for the disposable Compute Engine workspace
backend introduced by #605. Firebase Hosting, Auth, Firestore, Cloud Storage,
and Cloud Functions remain the control plane. The VM feature is disabled until
the isolated proof and release gates in this page have passed.

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
`mapache-runtime-provider` labels; cleanup refuses foreign labels.

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

### Isolated rollout Functions

`vmRuntimeControl_v2` provides session-token authenticated coordination through
the backend-only `vmRuntimes_v2` registry. This registry does not trigger the
legacy workspace session workers. Each operation verifies the stored token
hash, owner, current session, generation, state, and admitted boot. One boot
can acquire the reservation; expired/released boots cannot reclaim it. A
45-second lease renews every five seconds; unavailable coordination revokes
runner admission and stops the managed agent child. Only the controller may
reserve a new generation after fencing the old compute.

The broker supports authority acquire/check/renew/release, constrained activity
and history, model selection, and selected canonical agent credentials. It
does not expose generic Firestore reads, arbitrary update fields, owner-wide
credential maps, or provisioning actions. The HTTP Function is network-public
because the VM has no Google identity token; every action requires the separate
session control token. Browser access tokens do not authorize these actions.
Control tokens travel over HTTPS and are never accepted as browser credentials.
`scripts/vm-control-probe.mjs` creates unique synthetic registry records, tests
the deployed broker, then deletes only those probe records. On 2026-11-23 its
live checks passed concurrent boot fencing (one 200/one 409), wrong-token 404,
stale-generation rejection, arbitrary-write rejection, model-selection round
trip, and expired-lease rejection. This is control-plane evidence, not VM
browser/session acceptance.

The fixture controller stores its raw bootstrap material in the backend-only
`vmRuntimeCredentials_v2` collection, while the registry stores only its control
token hash. This is a synthetic fixture controller, not the production migration
coordinator. `scripts/vm-crossover-fixture.mjs` now reserves an isolated generation
and starts the normal runner without startup-smoke mode. Its registry and secret
records are retained for repeatable inspection and are not user workspace data.

Runner VM operations use `session-runner/lib/vmRuntimeControl.js`; Cloud Run
keeps its existing authority implementation. VM startup requires an explicit
`MAPACHE_VM_CONTROL_URL` and `MAPACHE_VM_CONTROL_TOKEN` and never falls back to
ambient metadata credentials. VM Chrome startup uses the retained profile in
place, clearing only stale process locks. Legacy Chrome seed/archive timers and
agent checkpoint uploads are disabled for this backend; independent disk backup
and migration/recovery operations remain required release gates.

For code-only canaries affecting `lib/` and `server.js`,
`session-runner/cloudbuild.vm-canary.yaml` builds on an immutable `_BASE_IMAGE`
and publishes only `_IMAGE`. It compares both package manifests to the base
image and refuses dependency changes. Other source/dependency changes require
the full gcp-runner build. Its ordinary startup smoke is a compatibility check;
the live VM broker/lease/agent path must still be verified separately.

The broker-enabled generation-4 fixture completed normal startup (smoke mode
off), acquired its control-plane lease, launched Pi Web UI, and returned the
authenticated agent page and application bundles successfully. That image still
predated the baked-path precedence correction, so it is startup evidence only.
`scripts/vm-runtime-proof.cjs` is the stronger in-container check for authenticated
health, functional agent readiness, blocked metadata-token access, retained
workspace, and retained child HOME. The health path skips legacy Firestore
checkpoint reads for VM storage; backups are a separate concern.

Generation 5 (`mapache-vm-d0af925469e49c4467ec0bd6`) passed that stronger
runtime proof on 2026-11-23 with immutable image
`sha256:a65b97e030790abfe1dc8e7d3de5cc8c30bf753cfddada062f1dd358c161fecc`.
Unauthenticated health returned 404, authenticated health returned 200 with
the agent ready, metadata-token access was blocked, and a real child used the
retained HOME and workspace. The authenticated agent page and all referenced
JavaScript bundles also passed the HTTP smoke check. The persistence verifier
passed inside this running normal runner against the original generation-2
Git HEAD and retained SQLite/native executable/mode/symlink/lock fixtures.
These checks do not establish browser interaction, model-provider authentication,
WebSocket routing, or user migration. The private gateway remains a release gate.

The isolated proof uses synthetic identity `vm-proof-605` / `vm-proof-owner`;
`scripts/vm-crossover-fixture.mjs` accepts no user workspace ID. Its operations
are `inspect`, `start`, `pause`, and `replace`, followed by a generation and
(for start/replace) a project-owned immutable runner image digest. Replace
deletes only the ownership-verified fixture instance and auto-delete boot disk;
the data disk remains. `scripts/vm-persistence-proof.cjs seed|verify` runs inside
that fixture container and checks dirty Git state, symlinks, modes, SQLite,
file locking, atomic rename, and a compiled native executable. This harness
does not yet establish browser-profile, package-manager, backup, or migration
release gates.

The deployed proof infrastructure in `pi-agents-cloud` is:

| Resource | Configuration |
| --- | --- |
| VPC `mapache-vm-v2` | Custom subnet mode; separate from existing services |
| Subnet `mapache-vm-v2-us-central1` | `us-central1`, `10.90.0.0/24`, Private Google Access |
| Router `mapache-vm-v2-router` | `us-central1`, on the proof VPC |
| NAT `mapache-vm-v2-egress` | Auto-allocated external addresses; only the proof subnet |
| Firewall `mapache-vm-v2-iap-ssh` | TCP 22 from IAP `35.235.240.0/20`, tag `mapache-vm-v2` |
| Custom role `mapacheVmProvisionerV2` | Instance create/delete/get/start/metadata/service-account/tags/labels; disk create/get/use/labels; subnet use; zone-operation get; image use-read-only |

Only `mapache-api` receives the custom provisioning role. Existing
`iam.serviceAccountUser` on `mapache-runner` supplies actAs; the runner retains
its existing Artifact Registry reader grant. VMs have no external access config.
The startup script blocks container access to the metadata HTTP endpoint while
allowing host image authentication. NAT and retained disks incur charges even
between proof runs; pause removes compute, not those infrastructure resources.
COS host Docker configuration lives under `/var/lib/mapache/host-home` on the
disposable boot filesystem because `/root` is read-only. The runner identity
also has `roles/logging.logWriter` for guest startup diagnostics.

VM terminal/tool child processes must receive retained HOME, XDG config/state,
caches, and the retained user-local executable directory. Owners are
`session-runner/lib/runnerEnvironment.js` and `session-runner/lib/config.js`.
Temporary sockets/locks remain under container `/tmp`. Changes to these files
require a new canary runner image; existing Cloud Run images are unaffected.
Retained paths take precedence over legacy image environment defaults, including
`WORKSPACE_DIR`, `CHROME_PROFILE_DIR`, `PREVIEW_STATIC_ROOT`, and user-local tool
paths. Regression coverage supplies those baked defaults and checks the actual
configured paths, rather than only checking the retained-path helper object.

The first live boot exposed direct Firestore calls that depended on ambient
Google credentials. The scoped control broker now permits normal agent startup
with metadata credentials fenced, as verified by generation 5 above. Remaining
compatibility paths still need validation before migration.

On 2026-11-23 the clean replacement filesystem proof passed from fixture
generation 2 (`mapache-vm-35530052c17c57f4310967d3`) to generation 3
(`mapache-vm-b732e83747943dda08a0cc3e`), using retained disk
`mapache-ws-efaf283eb879545a0e7ba4d3`. Both seed and verify reported Git HEAD
`9850d196d8e77c5e0ce1a72364cbb5a4f5b67217` and passed native executable,
SQLite, mode, symlink, and locking checks. Verification ran as an offline
container command from the pinned existing runner image, not as an authenticated
user session. Hard-loss/open-write recovery, browser state,
package installation, and backup restore remain separate unpassed gates.
The API-identity preflight now reports no missing checked Compute permissions.

Canary build `e3dfe040-ecab-4bcd-8dc5-5396ce730736` succeeded and published
`vm-crossover-c431211` (digest
`sha256:82c6f6db5286091d53b6a262337e35f7b8a69124c4064ae83a74f2114a6c53c3`).
It predates the retained-HOME child-environment correction; that correction
requires the next image. The production `gcp-runner` tag was not moved.

`vmRuntimePreflight_v2` is an IAM-private, read-only HTTP Function owned by
`functions/vmRuntimePreflight.service.js`. It checks the deployed API identity
for Compute permissions and gateway configuration without changing workspace
admission, session documents, or Hosting routes. It always reports live release
validation as outstanding; configured permissions alone are not readiness.
Deploy it independently with
`firebase deploy --only functions:vmRuntimePreflight_v2 --project pi-agents-cloud`.
Existing API, provisioning triggers, and Cloud Run services retain their deployed
revisions. Future VM workers must use separate names and isolated records so
legacy Firestore triggers cannot claim the same work.

On 2026-11-23 the isolated preflight deployed successfully under
`mapache-api@pi-agents-cloud.iam.gserviceaccount.com`: unauthenticated requests
returned 403 and an authenticated operator request returned 200. The deployed
identity initially lacked all eight checked Compute permissions. After the
dedicated infrastructure grants, preflight reported no missing checked permissions.
Gateway configuration remains absent and admission disabled. Next gates include
authenticated gateway routing and verified canary migration. No existing
workspace has been migrated by this Function.

The Compute bootstrap sets its marker-validation identity explicitly, uses a
bounded ext4 volume label and an explicit attached-disk device name. Compute
request IDs are deterministic UUIDs scoped to each resource and operation.
Ownership label values are case-sensitive identity hashes because Firebase IDs
can contain uppercase characters forbidden in Compute label values; the disk
marker retains the full original identity for filesystem verification.
These fixes require deployment of the eventual VM worker, not a runner image
rebuild; they are not evidence of a successful live VM replacement.

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

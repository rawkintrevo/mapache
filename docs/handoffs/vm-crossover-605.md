# VM crossover #605 handoff

Handoff date: 2026-11-25 (America/Chicago). The validation-boot continuation, VM automation-agent authority boundary and deployed lifecycle-worker recovery proof are complete; the broader migration remains open.

## Start here

- Parent [#605](https://github.com/rawkintrevo/mapache/issues/605); one draft [PR #629](https://github.com/rawkintrevo/mapache/pull/629).
- Continue branch `605-vm-crossover-isolated-functions`. Do not create another PR, return implementation to main, force-push, merge, or retire legacy operation as part of resuming this work.
- The last verified clone-copy increment is `773098d`. The PR head preserves the clone-boot implementation, and the validation boot operator path is now implemented and has passed a disposable live proof on the continuation branch.
- Commit `1818c9d` closes the VM automation-agent admission gap: VM bootstrap injects the Functions-owned token/API URLs, and token/API admission joins the nested VM session with its separate credential record while fencing generation, boot ID, lease, and explicit API admission.
- A live probe against `vm-proof-605` minted a token from the deployed `automationAgentToken` revision and received `200` from `/api/agent/workspace-requests/targets`; the temporary API admission was restored to `false`.
- The same live VM controller path reached `/workspace/models` with the signed browser token plus shutdown-token header and returned `1,698` catalog entries. The fixture has no selected provider credentials, so entries are unavailable and no model turn was attempted.
- This boundary is now reproducible with `node scripts/vm-automation-agent-proof.mjs`; the live report is sanitized at `artifacts/qa/vm-automation-agent/proof.json` and confirms temporary admission restoration.
- The current continuation also closes a VM automation admission race: a main-exclusive run now reads the canonical VM runtime in the same Firestore transaction, so a stopped legacy session cannot mask an active or transitioning Compute Engine machine. Focused admission coverage proves it remains queued until the VM is stopped.
- The scheduler now applies the migration fence to its direct run/pointer transaction as well. A fenced tick leaves the due occurrence and `nextRunAt` untouched, then resumes it after fence release; focused coverage proves no run or queue wake is emitted while fenced.
- Automation definition and workspace concurrency-setting CRUD now checks the migration fence in the same transaction as each create, update, delete, or settings write, so schedule control cannot change after migration admission.
- New owner/agent workspace-request ticket creation checks the migration fence before publishing `workspaceTickets/{id}`; existing ticket reads and idempotent lookups remain available while queued work stays reconcilable.
- Legacy session rename and session-bound Pi auth/environment selection now check the migration fence in the same transaction as their session writes, preventing metadata or credential selection from publishing after admission while leaving owner-global credential storage independent.
- Direct user session deletion now uses the same fenced lifecycle transition; internal deletion after an already-admitted workspace tombstone remains available for cleanup, while manual stop remains the drain path.
- Rough continuation estimate: **95%** by engineering judgment after the lifecycle recovery, Compute resource mapping, VM settings editor, idle-stop policy, live E2 resource proof, isolated backup-recovery proof and deployed worker crash/retry proof increments. No existing workspace has completed cutover. All 19 issues remain open. Checked acceptance criteria describe individually verified outcomes.
- [VM Workspaces](../vm-workspaces.md) is the subsystem contract. Some sections describe the intended system; use the issue evidence/remaining matrix below to distinguish it from implemented behavior.

## Authorization and invariants

The user authorized #605 and all 18 children, work on this same branch/PR, and isolated deployments. Prefer new function names ending in `_v2` and preserve existing Cloud Run operation.

All cloud commands must explicitly target `pi-agents-cloud`. Functions use `mapache-api@pi-agents-cloud.iam.gserviceaccount.com`; runner VMs/services use `mapache-runner@pi-agents-cloud.iam.gserviceaccount.com`. The alternative `mapache-session-runner` identity does not exist. Health is exclusively `/runner/health`. Do not change old writer/provider authority, delete source data, or claim migration based on local import receipts. Do not launch both old and new workspace writers.

The VM paths skip ordinary HOME/workspace/profile checkpoint restore/upload; migration readers are separate. Preserve owner-selected credentials via brokers and avoid copying secrets into public records, manifests or logs. No full real authenticated model turn is yet established.

## Live state rechecked at handoff

- Synthetic workspace `vm-proof-605`, generation 24, registry state `active`, desired/applied configuration version 4, no active operation. `apiEnabled=false`; `lifecycleEnabled=true`. The live owner proof paused generation 23, applied a validated 64-to-65 GiB disk expansion, replaced the VM successfully after worker crashes at every exercised boundary, reached authenticated readiness, and restored temporary API admission.
- Current session: `vm-32b56596e4121e4f41ba7d64-g24`. Its current boot ID and lease were accepted by the live lifecycle health gate; no temporary QA marker or crash-injection environment remains.
- VM `mapache-vm-d681fdb754c93f7d6292b0f3` is RUNNING in `us-central1-a`, machine type `e2-standard-2`.
- Attached retained disk `mapache-ws-efaf283eb879545a0e7ba4d3`: 65 GiB `pd-balanced`, READY and attached to the generation-24 VM. The running VM, retained disk and private networking continue to incur costs. Nothing was deleted for this handoff.
- Dedicated gateway: `mapache-vm-gateway-v2`. The IAM-private read-only Functions `vmMigrationPreflight_v2` and `vmMigrationStatus_v2` are ACTIVE in `pi-agents-cloud`. Firebase created `vmMigrationValidationControl_v2` and updated `vmMigrationStatus_v2` before the pause. The validation broker accepts runner requests over public HTTPS using a validation-session bearer token. A GET returned 405 and a POST for an unknown validation session returned 404. Anonymous status returned 403. Legacy writer guards and Firestore/Storage rules remain staged, and the opt-in frontend remains off production Hosting.
- Pinned runner image: `us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner@sha256:885a04f85bc34d8987523624f2c7bd9fe704b0121d483971adfe227299c7b3b8`.
- Registry/control collections: `vmRuntimes_v2`, `vmRuntimeCredentials_v2`, `vmLifecycleOperations_v2`, `vmGatewayRoutes_v2`. Never dump credential documents, Compute bootstrap metadata or full environment values.
- The real `vm-test` is a different, unmigrated legacy workspace. Its recorded Cloud Run service is absent; do not confuse its local recovered files with the running synthetic VM.

## Concrete recovery gaps

1. `vm-test`: neither canonical nor historical HOME prefix has current, noncurrent or soft-deleted objects. Bucket versioning was disabled; soft-delete retention was seven days. The old Cloud Run service no longer exists. This leaves full HOME recovery unproven, not proof that HOME was empty or that every byte is lost. A checkpoint-publishing early return is a possible explanation, but the deleted service's deployed code was not verified; do not assert it as root cause.
2. Sole shared-tree record: its referenced bucket returns 404. The tested handoff inventory now records `shared_bucket_not_found`, rather than merely `not-read`. Do not recreate an empty bucket or reinterpret this as a successful empty migration.
3. The full inventory had 15 missing manifest references, one schema/identity mismatch and one invalid reference. Other recoverable formats/live state still need reconciliation. The registry scan is not an atomic cutover snapshot.

Do not repeatedly retry these known absent sources without new evidence. Continue deterministic format/recovery work and record concrete blockers; seek a recovery decision only when a real cutover depends on accepting incomplete data. Keep original sources and available recovered artifacts intact.

## Verified recovery and evidence boundaries

- Registry inventory: 85 legacy records with stable IDs/owners (27 inactive, 57 without sessions, one excluded SSH), plus one isolated VM fixture. No record cutover-ready.
- `vm-test` checkpoint recovery: 36 agent files/objects (1,236,845 bytes), eight workspace files/objects (29,047 bytes); locally assembled/verified.
- Browser archive: 48,086,059 compressed bytes, 324 files, 119 archived directories plus one implied parent; locally restored and verified.
- Disposable-copy Chrome proof: Chrome 148.0.7778.178 rendered a synthetic page in a network namespace with no external interfaces and exited zero. SQLite passed for 20 databases before/22 after. Source fingerprint unchanged; owned Chrome/profile cleaned. This is not headed VM/noVNC, sandbox, encrypted credential or external login evidence.
- Owner tools: three files (65,988 bytes) and five directory markers assembled under `home/.local`. The four-source local candidate contains 371 files and 146 directories. Shared-owner writer reconciliation remains open.
- Transfer, checkpoint assembly and archive extraction passed real child-process SIGKILL/retry tests. A separate synthetic proof interrupted publication on a real GCE Persistent Disk, resumed, then booted the ordinary COS runner with the imported disk. Authenticated `/runner/health` reported the agent ready after startup and the imported executable and history matched. The disposable proof resources were cleaned up. The remaining recovery gaps are abrupt VM open-write recovery, ENOSPC and all-format real import.

Private ignored evidence remains on this workstation under `artifacts/qa/`: `vm-migration-inventory/`, `vm-checkpoint-import/`, `vm-browser-archive-import/`, `vm-browser-profile-proof/`, `vm-owner-tools-import/`, `vm-shared-tree-inventory/{initial,handoff}.json`, `vm-gateway-replacement/`, `vm-lifecycle/`, `vm-owner-api/`, `vm-environment/`, `vm-configuration/` and `vm-client-routing/`.

These directories do **not** travel with Git. They can contain private restored files, filenames, IDs and settings. Do not upload them to the PR or commit them. Use aggregate summaries in docs/issues; arrange secure evidence access or rerun proofs if a new workspace lacks them. Some report writers are create-only; choose a new output path instead of overwriting prior evidence. Frontend screenshots were inspected but connector upload was unavailable; PR records their local paths.

## Code map and checks

- Backend: `functions/vm*.js`, `computeEngine.service.js`, `runtimeProvider*.js`.
- Runner: `session-runner/lib/retainedDiskStorage.js`, `vmRuntimeControl.js`, retained-path config/startup; broker-selected auth/environment.
- Frontend: `src/services/vmWorkspaceApi.js`, `VmWorkspaceEditModal.jsx`, ModalStack routing; `VITE_VM_WORKSPACES_ENABLED=true` opt-in.
- Migration: `scripts/vm-migration-inventory.mjs`; `scripts/lib/vm-{migration-inventory,checkpoint-payloads,storage-metadata,archive-verifier,import-stage,checkpoint-import,import-tree,archive-import,archive-tree,owner-tools-import,shared-tree-authority}.mjs`.
- Source sharing provenance checks only original bucket/marker/control identity. HNS folder inventory, mutable current contents and writer reconciliation remain unverified; never use the legacy ensure/validate service in read-only inventory because it can repair IAM.

## Cutover state

- The live read-only preflight saw the recorded `vm-test` Cloud Run service absent and no unfinished recorded operations. A regional scan found zero matches in 31 current service templates in `us-central1`. Historical revisions, other regions and remaining writer paths still require reconciliation.
- Two bounded Storage listings agreed for 568 objects. An initial combined check detected a Firestore observation change and refused the result. A separate Storage-only check was stable. The missing persistent HOME blocker remains.
- The Firestore emulator proved one reservation winner, stale-observation and shared-prefix refusal, and atomic release of the workspace and Storage fences. The production endpoints expose read-only preflight and status. No production reservation or writer drain is authorized by those endpoints.
- The coordinator's `confirmQuiesced` transition checks ownership of both fences, records Compute and Storage observation digests, and rechecks Firestore, the operation and both fences before committing. Emulator tests cover stale observations, concurrent retries and a pre-switch abort. The transition has no production mutation entry point.
- The fenced capture binds exact Storage generations to checkpoint, HOME and browser staging. A private read-only maintenance workflow verifies the mounted import receipt and exact provider disk ID before the coordinator accepts the detached destination disk. A live disposable disk copy verified the provider's source disk ID and was removed.
- The checkpoint adds an internal `startValidationBoot` path using a separate Firestore registry, dedicated broker, short lease deadline and clone-only Compute attachment. `scripts/vm-migration-validation-boot.mjs` drives reservation, clone preparation, boot, temporary validation-gateway health attestation and ID-checked cleanup. Compute instance creation and authenticated runner readiness remain separate milestones. Focused tests cover the isolated gateway route and clone deletion. On 2026-11-24, an isolated workspace fixture booted with a newly published pinned runner image; authenticated `/runner/health` returned 200 with `agentReady=true`, and the command reported `instanceDeleted=true` and `diskDeleted=true`. Post-run checks found no validation VM, clone disk, validation route or credential document; the source disk remained detached and READY. The disposable maintenance VM and dedicated temporary gateway service used to prepare and reach this fixture were also deleted.
- The durable backup-recovery adapter is deployed, but remains fail-closed: `vmBackupRecoveryControl_v2` is ACTIVE at `vmbackuprecoverycontrol-v2-00001-guw`, `vmBackupReconcile_v2` at `vmbackupreconcile-v2-00011-mur`, `vmApi_v2` at `vmapi-v2-00017-hiy`, and `vmGatewayResolve_v2` at `vmgatewayresolve-v2-00007-dob`. All four run as `mapache-api@pi-agents-cloud.iam.gserviceaccount.com`; the runner configuration remains `mapache-runner@pi-agents-cloud.iam.gserviceaccount.com`. `VM_BACKUP_RECOVERY_GATEWAY_HOST` is not configured and the deployed `SESSION_RUNNER_IMAGE` is still the mutable `:latest` value, so no recovery reservation can mutate Firestore, Compute or gateway state until a dedicated `backup-recovery---...run.app` host and immutable image digest are deliberately configured. No production recovery operation was invoked.

## Checks and continuation

At handoff, the Functions package suite, all seven existing coordinator Firestore emulator cases, lint and docs checks passed. Prior evidence includes 55 focused import and maintenance cases, 281 frontend tests, normal and VM-enabled builds, and synthetic Chrome DevTools routing and editor QA. Full live authenticated frontend acceptance remains open.

```bash
node --test functions/vm*.test.js functions/{sessionLifecycle,cloudRun,sessionCreation,workspaceUploads,sessionResize,workspaceSessionReservation,automationRuns,automationAdmission,automationProvisioning,workspaceRequestRuntime,workspaceAutomationDeletion}.service.test.js
firebase emulators:exec --only firestore --project demo-mapache-cutover 'node --test functions/vmMigrationCoordinator.service.test.js'
npm run docs:check
```

1. For #616, the disposable clone-boot path has passed readiness and cleanup evidence, including empty validation credentials, retry/recovery of the clone identity, lease fencing and ID-checked teardown. A lease deadline does not delete cloud resources. The guarded legacy Functions and Firestore/Storage rules were deployed on 2026-11-24; the remaining live work is deployed-writer drainage, a real cutover canary, and rollback rehearsal after VM writes.
2. Verify deployed legacy writer fencing and drainage, including old upload URIs, outstanding operations and integration bindings. Session creation now keeps canonical-session and manual-schedule metadata updates inside its fenced reservation transaction, closing a post-reservation workspace-writer race. Bind verified source, import and clone evidence to the atomic authority switch, then use the two-phase rollback action to stop the exact destination VM and restore source authority only with a current reverse-import receipt.
3. For #614 and #615, complete shared-tree, private-Git and live/unpublished source reconciliation. Establish an explicit recovery decision for unavailable sources before attempting a real cutover. Extend the disk import proof to representative complete data, capacity and recovery, then validate the runtime and app on the imported disk.
4. Complete stopped-machine schedules and requests, central settings and integrations, headed browser and sandbox, direct resumable uploads, and VM backup and recovery. Pass the #618 release matrix before #619 canaries and cohorts. #620 remains gated on reconciliation and rollback retention.

## Ticket-by-ticket reconciliation

### #606: Partial — architecture contract recorded

Evidence: The durable path/ownership/lifetime table and separate-backup lifecycle contract are in docs/vm-workspaces.md; the VM path skips ordinary HOME/workspace/profile checkpoint restoration and upload.

Remaining: Finish concrete owner-wide sharing/automation decisions, measured costs/quotas, recovery targets, disk-growth operations and the detailed module-level simplification audit. Normative design text is not implementation evidence.

Fully evidenced original acceptance criteria: 1, 3.

### #607: Partial — clean replacement proof passed

Evidence: The actual retained Linux disk preserved dirty/untracked Git, SQLite, a native executable, modes, symlinks, rename and locking through repeated VM replacements. Initial disk creation/marker fencing and functional /runner/health checks passed.

Remaining: Complete abrupt compute loss with open writes, representative install/history/browser acceptance, measured I/O/memory/cost and the complete go/no-go report. The synthetic fixture remains running.

Fully evidenced original acceptance criteria: 2, 3.

### #608: Partial — isolated infrastructure deployed

Evidence: Private VPC/subnet, outbound NAT, IAP access, scoped provisioning, retained-disk labels and metadata fencing support the isolated VM gateway/runner. APIs use mapache-api; runners use mapache-runner.

Remaining: Finish the complete least-privilege negative matrix, reproducible full environment cleanup, quotas/concurrency limits, budget alerts and hard cost controls. Do not equate container metadata denial with every assigned-identity authorization test.

Fully evidenced original acceptance criteria: none; partial evidence does not satisfy the full criterion.

### #609: Partial — provider separation and isolated registry implemented

Evidence: Versioned provider/disk descriptors and focused VM services coexist with the legacy Cloud Run path. vmRuntimes_v2 and separate _v2 Functions isolate canary admission; frontend VM discovery is opt-in.

Remaining: Prove cross-backend canonical writer admission during actual migration, stale/invalid descriptor behavior across all entry points, complete legacy regression and end-to-end creation/provider integration. No existing workspace authority has switched.

Fully evidenced original acceptance criteria: 4.

### #610: Partial — retained-disk bootstrap proved on fixture

Evidence: Pinned-image startup verifies disk identity and marker, permits formatting only for positively identified initial creation, mounts durable paths and starts the ordinary agent. Existing data survives repeat start/replacement; no normal VM checkpoint restore/upload.

Remaining: Complete wrong/read-only disk and startup diagnostic matrix, full HOME/package/history/browser replacement acceptance, and production-facing creation integration. Browser runtime acceptance is not proven by the local restored-profile test.

Fully evidenced original acceptance criteria: 1.

### #611: Partial — asynchronous lifecycle exercised live

Evidence: Persisted reservation/quiesce/delete/provision/route/health phases, stable request IDs, generation fencing, worker claims and a scheduler operate on the fixture. Pause confirms compute deletion/disk detachment; start reuses that disk.

Remaining: Finish resource-change coordination beyond data-disk growth. Lifecycle reconciliation now walks a bounded ten-page document-ID cursor and selects eligible work past claimed or delayed records. Failed phases retain writer admission and use bounded exponential retry backoff capped at one claim window; quota and attachment-conflict responses now normalize to stable retry codes; the health phase now has a 30-minute deadline and an IAM-private same-operation retry for explicit stuck startup failures. A test-only child-process SIGKILL matrix now enters through the Firestore worker handler, covers quiesce, pause, resize, start, route, and health, and preserves claims while converging with one destructive pause/resize/start effect; desired disk growth runs after detach and before replacement start. A live deployed worker proof on operation `32b56596e4121e4f41ba7d64d99feb07eb20e28e69f53d887f90c76295ef36d0` crashed and scheduler-reclaimed quiesce, pause, resize, start, route and health, then converged to generation 24 with a 65 GiB disk. The first resize attempt exposed a missing `compute.disks.resize` grant; that permission was added to the least-privilege `mapacheVmProvisionerV2` role, and a retry after the later start crash proved resize idempotency. The temporary QA environment was removed and the clean worker/reconciler revisions deployed. Remaining lifecycle work is broader capacity/quota and non-disk resource coordination.

Fully evidenced original acceptance criteria: 3.

### #612: Partial — live HTTP/WebSocket gateway proof passed

Evidence: Owner/generation/boot/lease checks, fresh agent/shell access and stale-token rejection passed on actual private VMs. Route revocation closed an existing socket in 5.37 seconds; replacement/reconnection was measured. Canonical health is /runner/health.

Remaining: Complete real VM Chrome/VNC/CDP, upload/download and supported preview flows, full cross-owner/guessed-path matrix, reconnect UX, capacity/timeouts and cost measurements. Existing proof does not establish every browser surface.

Fully evidenced original acceptance criteria: 4.

### #613: Partial — VM request wake-up and native automation dispatch implemented, end-to-end gate remains open

Evidence: `functions/vmWorkspaceRuntime.service.js` recognizes an owner-matched, API-admitted Compute Engine workspace, submits one idempotent durable `start` lifecycle request for a stopped machine, waits for the current generation's boot/lease/gateway/readiness authority, and creates a short-lived agent access token without putting credentials in the ticket or run contract. The existing shared workspace-request broker reuses that canonical VM runner, re-reads VM identity before acknowledging dispatch, and retains the existing no-blind-replay and cancellation rules. Scheduled automation now records `executionRoute: vm-native-v1`, wakes or reuses the canonical VM, and dispatches only its run ID to authenticated runner control routes. `session-runner/lib/vmAutomationRuntime.service.js` creates a run-private bubblewrap child with a filtered read-only input snapshot, a hidden live workspace mount, private state, and durable retained-disk output. Cleanup retains output and releases the slot only after durable cancellation/terminal state; reconciliation probes canonical `/runner/health` and the run status. Focused tests cover stopped-target wake-up, API-admission gating, ready-target reuse, owner isolation, request dispatch without a Cloud Run sibling, native assignment/identity checks, snapshot/link isolation, restart-safe cancellation, provisioning, cleanup, and reconciliation. Commit `1818c9d` also injects the token/API URLs into VM bootstrap and makes the deployed token/API boundary understand the nested VM session plus separate credential document. A live generation-19 probe minted the VM token, called the agent target-discovery route successfully, and reached the runner model-catalog route with `1,698` entries; temporary admission was restored afterward. No model turn was attempted because the synthetic fixture has no provider credentials.

Remaining: Deploy and exercise this path against an eligible live VM with a real external request, model discovery, and a stopped-target scheduled/Run-now run. Verify real bubblewrap startup, provider/model selection, child crash and cancellation races, concurrent-run admission, output visibility and retention, safe idle/scheduled shutdown, cross-machine tool sharing, and correct usage accounting. No full #613 acceptance criterion is met; the native implementation is staged but not live-proven.

Fully evidenced original acceptance criteria: none; partial evidence does not satisfy the full criterion.

### #614: Partial — registry and several source formats verified

Evidence: Read-only inventory accounted for 85 legacy workspace records plus one isolated VM fixture. It reports IDs/owners/generations and source blockers; selected vm-test checkpoints, browser archive and owner tools were verified. The deployed preflight also compared 568 object generations and reported the missing HOME. The formerly unfinished shared-tree provenance check is now tested and reports shared_bucket_not_found for the sole shared-tree record.

Remaining: Complete hierarchical folder/current shared-object/private-Git/unpublished/live-only reconciliation, consistent final captures, actual disk sizing, downtime and costs. vm-test HOME recovery is unproven; the shared bucket returns 404. Neither is an empty-source success.

Fully evidenced original acceptance criteria: 1, 3.

### #615: Partial — synthetic disk import and ordinary runner startup passed

Evidence: Verified checkpoints, browser files and owner tools were merged locally. A disposable GCE Persistent Disk import resumed after interruption and booted the ordinary runner with imported executable and history data intact.

Remaining: Resolve shared-tree, private-Git and missing HOME sources. Verify a complete real import, application and dependency behavior, real ENOSPC, huge files, interruption and cleanup.

Fully evidenced original acceptance criteria: none.

### #616: Partial — read-only preflight and disposable clone boot tested

Evidence: Deployed read-only operator preflight and status and the separate validation broker. Workspace and Storage reservation, quiesce, pinned capture and import-receipt verification passed emulator checks. Private read-only import evidence, separate validation clone creation and a disposable validation VM boot were verified on Compute resources. The boot returned authenticated `/runner/health` 200 with the agent runtime ready, then deleted only the validation VM and clone disk and removed its route and credentials.

Remaining: Drain existing writers and make the verified stages available to an eligible production operation. Google Workspace OAuth start/callback, binding mutations, and shared-connection refresh/revoke/update writes; GitHub owner-level OAuth callback and disconnect writes plus runner token refresh; and browser egress gateway assignment writes now consult the migration fence, including connection deletion cleanup and shared-route rewrites; deployed-writer drainage and integration reconciliation remain open. The new `vm-migration-destination-runtime.mjs` action stages a deterministic hidden `vmRuntimes_v2` destination on the exact imported disk, starts the pinned runner, and verifies authenticated `/runner/health`; its cleanup action stops only that staged VM and removes its records while retaining the disk and both fences. The review command then binds the backend-owned destination registry, exact attached disk, pinned runner and health evidence. The follow-on `vm-migration-switch-authority.mjs` action performs the bounded Firestore compare-and-swap: it hides the destination until commit, marks the retained legacy source as VM-owned, keeps both fences, and records destination authority. The separate `vm-migration-reconcile-source.mjs` action rechecks legacy Firestore/Storage and provider absence and records bounded evidence without deleting the source. The `vm-migration-rollback.mjs` action revokes destination admission, stops the exact VM, requires a generation-bound `mapache-reverse-import-v1` receipt, and atomically restores legacy authority while retaining the destination disk. No production workspace has invoked these mutations; live rollback evidence remains open.

Fully evidenced original acceptance criteria: none.

### #617: Partial — policy, durable scheduler, restore evidence boundary, and provider receipts implemented; lifecycle remains open

Evidence: A daily crash-consistent snapshot/14-day retention target and separate application-consistent migration capture are documented. Normal pause retains the data disk; that is not a backup.

The current checkpoint adds `functions/vmBackupPolicy.helpers.js` and threads it
through `functions/computeEngineBackup.service.js`. Focused tests cover the
daily/14-day policy, quiesce-required application consistency, generation-bound
snapshot and restore receipts, retention holds/quarantine, deletion guards that
distinguish tombstones from pause, undersized restore refusal, and explicit
disk-headroom unknowns. `functions/vmBackupScheduler.service.js` now records
workspace/generation-bound backup operations in `vmBackupOperations_v2`, uses
exclusive claims and retry timestamps around provider calls, verifies ready
snapshots into `vmBackups_v2/{workspaceId}/items`, creates guarded retention
delete operations, and refuses reservations behind a migration fence.
`vmBackupReconcile_v2` is a 15-minute opt-in scheduler; no current VM record
has been opted in. `functions/vmBackupRecovery.service.js` now reserves only
verified owned backups, creates fresh-target restore receipts, requires an
injected runtime/file verifier, measures the declared 24-hour RPO and one-hour
RTO targets, and records sanitized startup-timing reports with bounded retry on
transient readiness errors. Existing legacy storage backup code is not VM
evidence.

Compute snapshot delete and restore receipts now poll named zonal, regional, or
global provider operations before completion; a pending retention delete keeps
its provider operation in the durable retry record and never issues a blind
second delete. The operation-polling boundary is covered by focused tests.

VM lifecycle receipts now record bounded per-phase durations and sanitized
failure phase/timestamp fields. The owner-scoped operation status projection
exposes those diagnostics so operators can identify a stuck or failed phase
before retrying; it does not start a replacement or change authority.

The same opt-in scheduler now writes a read-only
`vmBackupInventoryReports_v2/{workspaceId}` report. It records instance/disk
presence and attachment, backup age, retention holds/quarantine decisions,
stranded-resource observations, and known storage estimates while preserving
unknown compute/gateway/network cost components. It never authorizes cleanup
or deletes an orphan; provider pagination and ownership filtering remain
bounded at the backup-service boundary.

The owner-scoped `GET /workspaces/{workspaceId}/backup` projection now exposes
that inventory together with bounded recovery phase/error and RPO/RTO evidence.
It omits provider addresses, disk IDs, content digests, credentials, and raw
provider errors; it never authorizes cleanup. This is the diagnostics contract,
not proof of a fresh-VM restore or a numeric cost meter. Its backup inventory
also distinguishes provider-verified snapshots with both source file/runtime
digests from verified-but-undigested snapshots without exposing the digests.

The explicit expansion-only `scripts/vm-resize-disk.mjs` command now covers
the detached Compute resize step after owner, generation, and migration-fence
checks. It does not resize the guest filesystem or claim fresh-VM recovery;
those and live cost/release evidence remain open.

The authenticated `/runner/health` response now includes a bounded `disk`
projection from `statfs` when available, with capacity, used/free/available
bytes, headroom percentage, storage mode, and measurement time. An unknown
probe remains explicitly unknown; provider capacity is not treated as guest
headroom.

The guest-side expansion step is now represented by the guarded operator
command `scripts/vm-grow-filesystem.mjs`. It requires the stopped, owner-matched
runtime and exact detached disk, an explicitly identified private maintenance
VM, and `--confirm-grow`; it attaches the disk read/write, runs `e2fsck -pf`
and `resize2fs` through the installed remote helper, verifies the retained-disk
marker and read-only `statfs` projection, then detaches the disk. It does not
start a workspace VM, change authority, or release writer admission. A normal
start and authenticated health check are still required after the operator
action; fresh-VM recovery and release evidence remain open.

The runner now exposes authenticated `/runner/recovery-digest` only on the
canonical runner surface. It returns a bounded SHA-256 digest and counts for
the retained tree without returning paths or contents. The operator-only
`scripts/vm-backup-recovery-proof.mjs` restores a verified backup to a
deterministic fresh disk, starts a pinned private VM, checks `/runner/health`
and the digest over IAP SSH, records restore/start/readiness and RPO/RTO
timings, and cleans up only the exact proof VM and detached disk. It refuses to
report success when the source backup lacks an expected file digest, and it
does not write authority, create a route, or delete the source backup/disk.
The durable production recovery adapter is now wired through
`functions/vmBackupRecoveryRuntime.service.js`. It uses isolated recovery
runtime/session/credential records, a dedicated `recoveryOnly` gateway route,
the isolated `vmBackupRecoveryControl_v2` lease endpoint, a pinned runner
image, authenticated `/runner/health` plus `/runner/recovery-digest`, and exact
VM/disk cleanup before terminal failure. The scheduler reconciles pending
recovery operations and the owner-scoped VM API can reserve one with
`POST /workspaces/{workspaceId}/backup`. The adapter fails before mutation when
`VM_BACKUP_RECOVERY_GATEWAY_HOST` is absent or is not a dedicated
`backup-recovery---...run.app` host, or when `SESSION_RUNNER_IMAGE` is not
immutable. No production recovery operation was invoked by this change.

The opt-in backup scheduler now captures source `/runner/health` and
`/runner/recovery-digest` evidence for an active admitted VM before requesting
a snapshot, storing file/runtime digests and bounded probe timings. Stopped
sources and probe failures retain an explicit missing-digest state rather than
inventing comparison evidence.

The read-only operator helper `scripts/vm-cost-report.mjs` now turns a complete
usage/rate worksheet into a numeric monthly report. It requires explicit
monthly-equivalent usage plus retained-disk, snapshots, compute, gateway, NAT, egress, logging/operations,
migration-overlap, and failed/orphaned-resource values and preserves the usage
and rate source timestamps. Missing values fail closed; explicit zeroes remain
numeric. It makes no cloud calls and does not change the inventory's deliberate
unknown-cost behavior. No current billing export was supplied or treated as a
measured production cost result.

The durable recovery controller now also requires its runtime adapter to expose
exact-operation cleanup. It now also requires both source file and source
runtime-state digests before accepting target evidence; an undigested backup
fails closed and is cleaned up rather than being reported as file-verified
recovery. A file/runtime verification mismatch enters a bounded
retryable `cleanup` phase until both the recovery VM and target disk are
confirmed absent; it cannot become a terminal failed report while resources are
unknown.

Continuation update (2026-11-25 UTC): the dedicated gateway host is configured
and the recovery reconciler is active at revision
`vmbackupreconcile-v2-00023-yan` with immutable runner image
`us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner@sha256:083f1c7f4b7d167a7ef4324abb680c1221a20cc8211537df44f5cd21496f6e50`.
The diagnostic image build succeeded in 13m19.508270s wall-clock (Docker build
step 8m41.881640s), with the pi-web-ui cache hit and startup smoke test
passing. The preceding diagnostic build identified the stale snapshot lock;
the deployed recovery-only process now permits replacement of that lock while
normal runners retain the upstream single-kernel guard.
Recovery-only runner containers use Docker `--restart=no`, while ordinary VMs
retain `unless-stopped`, so a failed recovery runner remains inspectable instead
of creating a restart loop. A proof with the previously deployed `f4cc...` image
reached a running VM but never acquired the lease because that stale image did
not expose the current runner health route; its VM, disk and isolated records
were cleaned up. Fresh-image proofs reached an active lease and restored the
disk, but the latest runner exited with status 1 during `agent_start` after
2,680 ms with `pi_web_ui_process_exited`; a live IAP watcher captured the
cause as a stale source-VM kernel lock in the restored disk. The lock-fix image
then completed the isolated fresh-disk/fresh-VM proof: authenticated health and
recovery digest matched the source file digest
`sha256:2fe7e047ab49adf80163858d074a916f57cbd39645e616d840b0bcdc125a944` and
runtime-state digest
`sha256:1534949e6b0e7b2cb2e1503400bc862e5709c60a46cb40bfa65a423c55f341d2`.
Provider restore took 20,916 ms; boot/lease 15,297 ms; health 8,342 ms; and
digest 646 ms, with total proof time 176,023 ms. RPO was 10,869,867 ms and RTO
174,870 ms, both within the 24-hour/one-hour fixture targets. The VM, restored
disk, route, lease, runtime and credentials were then cleaned exactly; post-run
checks found no recovery VM/disk, route/runtime record, or credential record.

Remaining: Keep the successful result scoped to the synthetic fixture; extend
the proof to representative complete source data, crash/open-write and
capacity/zone-loss cases, surface actual measured costs, and provide a current
billing-backed worksheet. The read-only inventory now enumerates owned
Compute instances/disks before any future cleanup. The fail-closed
disk-full/zone-loss procedure is now in
`docs/runbooks/vm-disk-recovery.md`, but its resize and fresh-VM recovery
guest filesystem and fresh-VM recovery actions remain open. No
production snapshot, restore, retention deletion, or synthetic-fixture
mutation was performed.

Fully evidenced original acceptance criteria: none; partial evidence does not satisfy the full criterion.

### #618: Partial — isolated proofs, release gate unmet

Evidence: Repeated VM replacements retained the same filesystem without normal full-tree restore. Gateway/owner/API proofs, local migration fault tests and an isolated restored-browser-profile test passed. The synthetic retained-disk import and ordinary VM runner startup passed. Clone copy and the dedicated validation clone's runner boot/readiness/cleanup passed, including authenticated `/runner/health` and post-run resource absence checks. The current Functions suite and coordinator emulator cases passed.

Remaining: Complete all formats/failure transitions, real VM desktop/security/browser matrix, two-machine settings/inheritance, schedules and requests waking stopped machines, upload/resize/disk-full/backup tests, a real model turn and numeric rollout thresholds.

Fully evidenced original acceptance criteria: 1.

### #619: Not started — no user cutover

Evidence: A synthetic fixture and registry inventory exist; all real legacy workspaces remain unmigrated. VM discovery/admission are opt-in and the production Hosting build was not deployed.

Remaining: Prepare reviewed cohort manifests/runbook/rollback points/support messaging; pass upstream release gates, then canaries and bounded batches. Reconcile each eligible workspace as verified migrated or explicitly blocked with retained source and owner-visible status.

Fully evidenced original acceptance criteria: none; partial evidence does not satisfy the full criterion.

### #620: Gated — legacy paths intentionally preserved

Evidence: Existing Cloud Run Functions, runner tag and storage operation were preserved while isolated _v2 endpoints were developed. No migration-based legacy retirement has occurred.

Remaining: After verified cohorts and retention/rollback expiry, audit dependencies and perform ownership-checked resumable cleanup. Preserve APIs, unsupported/SSH workspaces, historical readers, backups/uploads/outputs and outstanding recovery sources.

Fully evidenced original acceptance criteria: none; partial evidence does not satisfy the full criterion.

### #621: Partial — retained profile path and local recovery proof

Evidence: The VM runtime opens its retained profile in place and disables ordinary main-profile archive cycles. A recovered vm-test profile opened in isolated local Chrome 148; SQLite integrity passed before/after and original files stayed unchanged.

Remaining: Prove the actual headed VM/noVNC desktop, login/cookie persistence, runner-version compatibility, native sandbox and /dev/shm, full interaction/reconnect matrix, process simplification/crash recovery and automation-profile isolation. Local headless --no-sandbox proof does not meet these criteria.

Fully evidenced original acceptance criteria: none; partial evidence does not satisfy the full criterion.

### #622: Partial prerequisite only — legacy large-file materialization

Evidence: The checkpoint importer stages actual large-file-v1 contents with bounded streaming and verified hashes rather than pointer JSON. Retained paths are defined.

Remaining: Implement authenticated resumable browser-to-disk uploads, offset/checksum/collision/cancel/quota policy, paused-machine UX, large real ingress tests, replacement/disk-full recovery and automation/request input compatibility. Do not remove legacy mounts/pointers before verified migration.

Fully evidenced original acceptance criteria: none; partial evidence does not satisfy the full criterion.

### #623: Partial — auth/environment, Compute resources, metadata, and idle policy implemented

Evidence: Owner-scoped auth/environment selection APIs and the opt-in VM modal support stale-save rejection, pending/applied revisions, validated E2 custom machine-type presets, and monotonic durable-disk growth requests. A paused-save/start live backend proof reached generation 11/config version 1; synthetic editor QA passed without secret disclosure.

Remaining: Finish defaults/inheritance across two machines, full Pi config/MCP/Google/gateway bindings, resource cost/quota UX, schedules, revocation/disk-restore semantics and full authenticated modal/reconnect QA. The current lifecycle maps catalog CPU/memory selections to validated E2 custom machine types during replacement; the fixed synthetic fixture now has live startup/readiness evidence for `e2-custom-2-4096`, but measured cost/quota behavior and the broader machine-property matrix remain open.

Fully evidenced original acceptance criteria: none; partial evidence does not satisfy the full criterion.

## Continuation evidence — 2026-11-24

The PR's full-tested runner image `sha256:19382971d1c23ac740ca1635cd6e1edbaca362214f299d3588363b9fe85b5279` passed the live owner/API sequence on the fixed synthetic workspace. The private owner probe passed discovery, canonical-session projection, anonymous and cross-owner denial, stale-generation denial, browser/API credential separation, and signed access URLs. The deployed lifecycle cycle passed pause/start idempotency and generation 13 to 14; the stopped-configuration proof passed save-while-stopped, stale-save rejection, cross-owner denial, and apply-after-start through generation 15. The environment-selection proof then passed a versioned owner-private selection through lifecycle replacement from generation 18 to 19: the new container received the marker, no runtime record contained its value, and cleanup restored the prior machine configuration and removed the private entry. The current fixture is generation 19, active and lifecycle-ready, with API admission disabled after the proof.

The owner-creation proof also passed after the documented temporary `create-proof` gateway revision tag was attached: duplicate suppression, owner-derived admission, forged infrastructure rejection, signed agent access, pause, and exact resource cleanup. The tag was removed immediately afterward; the creation workspace, admission, route, credentials and dedicated disk are absent. The browser `vm-live-shell` scenario produced a passing result with no console errors, a live VM Agent iframe, resource meters, signed VM API/access calls, and no legacy workspace listener. Its sanitized evidence remains under `artifacts/qa/vm-live-shell/`.

The fixed fixture replacement harness now preserves existing admission/configuration fields and selected session references without carrying stale generation boot/lease state into a replacement. The environment proof now exercises versioned machine configuration so the deployed lifecycle worker resolves owner-private values at launch, then restores the prior configuration. The configuration proof also exercises a live E2 custom machine replacement and now includes a restore mode for interrupted disposable-fixture runs. These corrections are committed on PR #629. Remaining live evidence includes a real model turn, broader runner/browser/sandbox and backup/recovery matrices, migration writer drain and authority-switch rehearsal, and the release/canary gates; these proofs do not establish user-workspace cutover.

The next executor increment is `ece9f72`: native automation now rechecks the
durable terminal state after child startup and at the submission boundary, so a
startup cancellation or child exit cannot issue a late prompt submission. The
focused executor suite passed 13/13, and the full repository check passed with
526 runner tests (523 passed, 3 skipped), 283 frontend tests, and both builds.
The hosted full runner image for this commit passed in Cloud Build
`b0c3697f-fbc1-447b-8803-2a937446985f` (12m39s total; 7m55s Docker step), with
digest `sha256:20a9f2335c63513d3a98b0398b07cc6aa4729a4b6a27b8d53ef3e518f36b84fe`.
That exact image passed the real local pi-web vertical slice 2/2 in about 60s.
This closes the code/test/image race-safety gate; live provider/model execution,
stopped-target scheduling, cross-machine tools, usage accounting, migration
cutover/rollback, recovery, and release cohorts remain open.

The iteration path now has an explicit `npm run check:fast` command for the
focused VM automation boundary: it passed 94 focused Functions tests and 58
focused runner tests, plus docs and syntax checks. The full `npm run check`
remains the handoff/release gate and passed before this workflow-only increment.
Pull-request runner-image builds now select upstream `fast` mode automatically;
main pushes and default manual builds remain `full`, and the workflow rejects
publishing a fast image. The latest successful full image build was Cloud Build
`a2a4de39-7f2a-4acb-9327-555bd273aca5`: 11m32.8s Cloud Build wall clock,
7m25.0s Docker build step, digest
`sha256:8865cc4ebf707393315e38d574d10596ba1a25698d09b3f3a9a99488a752f58b`.
This is an iteration-velocity improvement only; live provider/model execution,
stopped-target scheduled/Run-now execution, cross-machine tools, usage
accounting, migration cutover/rollback, recovery, and release cohorts remain
open.

The first automatic PR-fast image attempt showed that disabling cache restore
made a cache-hit iteration unnecessarily rebuild the upstream runtime. Fast
mode now restores only a verified full-mode cache when available; a fast cache
miss remains unpublished. This keeps the full-mode release boundary while
removing the upstream rebuild from the common unchanged-input iteration path.

The cache-hit path was subsequently verified on a fresh Cloud Build worker for
PR head `a34a7f8`: Cloud Build `113b4817-5200-4749-b99c-527da563f37e` logged
`cache decision=hit reason=verified`, completed in 13m2s wall clock (8m23s
Docker assembly and 2m34s image push), and passed the runner smoke test. The
immutable image digest was
`sha256:81f59ef6dbbcc2517023b603cb62a916503453e57058c5ef7e76063df039ebae`;
GitHub Actions run [45465470914](https://github.com/rawkintrevo/mapache/actions/runs/45465470914)
also passed. This confirms that unchanged-input fast iterations skip the
upstream test/build phase; the base/runtime Docker layers and image push remain
the dominant cost.

The VM request wake path also now handles a request racing an in-flight
pause/replacement: it waits for the durable operation to commit the machine
stopped, then submits exactly one generation-pinned, API-admitted start request.
The focused VM workspace runtime suite covers this boundary; it does not count
as live stopped-target execution evidence.

The usage-accounting continuation adds `functions/vmUsage.service.js` and
threads it through VM lifecycle transitions. Each completed pause/start/replace
operation records one deterministic user ledger entry and advances the
retained-storage cursor in the same Firestore transaction. Active VM runtime,
retained-disk GiB-seconds, and VM-native automation background seconds are
reported separately; background duration is not added a second time to
allocated runtime. Current active VM generations are included dynamically, and
older records without a known disk-size cursor remain explicitly unknown.
Focused VM usage, user-usage, VM lifecycle, and VM creation tests pass. This is
an implementation and accounting proof only; live stopped-target execution,
cross-machine tools, and release acceptance remain open.

## Continuation evidence — 2026-11-25 UTC

The live synthetic backup fixture now has a repaired Compute provider
descriptor, an enabled daily backup policy, and a successfully completed
crash-consistent backup. The backup record is `succeeded` and `verified`, the
source runtime and file digests are present, and the corresponding Compute
snapshot is `READY` with `storageBytesStatus=UP_TO_DATE`. The deployed backup
and lifecycle functions run under the production API service account, with the
minimum snapshot create/get/list/set-labels/delete and global-operation read
permissions added to the project provisioner role.

The recovery-proof hardening is committed in `9a7f761`, `41f3dea`, `c82feed`,
`0c152e9`, and `51d8147`: Compute operation labels are bounded to the provider's
63-character limit; restored-disk labels use the same hashed identity contract
as lifecycle ownership checks; proof SSH retries tolerate eventual IAP instance
visibility; instance creation waits for eventual Compute readback; and each
disposable recovery run gets a fresh Compute request identity. The proof uses a
known-good immutable runner image and exact VM/disk cleanup.

The remaining live recovery proof is temporarily rate-limited by Compute when
restoring repeatedly from the same source snapshot (`RESOURCE_OPERATION_RATE_EXCEEDED`).
The failed attempts were cleaned up exactly: no proof VM or restore disk
remains, and the source snapshot and source runtime are retained. The next
attempt must wait for the provider window and then demonstrate fresh-disk,
fresh-VM runtime/file verification plus measured RPO/RTO. This is still a
synthetic-fixture proof and does not establish user-workspace migration.

The recovery adapter now retries transient gateway 5xx responses, waits for
eventual instance visibility and disk detachment, accepts Compute's omitted
`users` field for a confirmed detached disk, and marks recovery-only runner
containers `--restart=no`. The latter keeps a disposable failed runner
inspectable and leaves retry/cleanup ownership with the recovery controller;
ordinary VM containers retain `--restart=unless-stopped`. Focused recovery,
Compute, proof, and runner-process tests pass. The latest live proof with the
no-restart behavior reached the isolated lease and then captured these startup
stages before the container exited: workspace source, checkpoint restore,
authority acquire, Chrome/profile startup, and `agent_start`; the final code was
`pi_web_ui_process_exited`. The VM, disk, route, lease, and credentials were
cleaned exactly. The next attempt must deploy the diagnostic image and capture
the child failure or successful authenticated health/digest evidence after the
Compute snapshot rate-limit window clears.

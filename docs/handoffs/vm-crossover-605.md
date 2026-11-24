# VM crossover #605 handoff

Handoff date: 2026-11-24 (America/Chicago). The validation-boot continuation is complete; the broader migration remains open.

## Start here

- Parent [#605](https://github.com/rawkintrevo/mapache/issues/605); one draft [PR #629](https://github.com/rawkintrevo/mapache/pull/629).
- Continue branch `605-vm-crossover-isolated-functions`. Do not create another PR, return implementation to main, force-push, merge, or retire legacy operation as part of resuming this work.
- The last verified clone-copy increment is `773098d`. The PR head preserves the clone-boot implementation, and the validation boot operator path is now implemented and has passed a disposable live proof on the continuation branch.
- Rough overall estimate: **50%** by engineering judgment. No existing workspace has completed cutover. All 19 issues remain open. Checked acceptance criteria describe individually verified outcomes.
- [VM Workspaces](../vm-workspaces.md) is the subsystem contract. Some sections describe the intended system; use the issue evidence/remaining matrix below to distinguish it from implemented behavior.

## Authorization and invariants

The user authorized #605 and all 18 children, work on this same branch/PR, and isolated deployments. Prefer new function names ending in `_v2` and preserve existing Cloud Run operation.

All cloud commands must explicitly target `pi-agents-cloud`. Functions use `mapache-api@pi-agents-cloud.iam.gserviceaccount.com`; runner VMs/services use `mapache-runner@pi-agents-cloud.iam.gserviceaccount.com`. The alternative `mapache-session-runner` identity does not exist. Health is exclusively `/runner/health`. Do not change old writer/provider authority, delete source data, or claim migration based on local import receipts. Do not launch both old and new workspace writers.

The VM paths skip ordinary HOME/workspace/profile checkpoint restore/upload; migration readers are separate. Preserve owner-selected credentials via brokers and avoid copying secrets into public records, manifests or logs. No full real authenticated model turn is yet established.

## Live state rechecked at handoff

- Synthetic workspace `vm-proof-605`, generation 11, registry state `active`, desired configuration version 1, no active operation. `apiEnabled=false`; `lifecycleEnabled=true`.
- Current session: `vm-1977e861d998de7357678d53-g11`.
- VM `mapache-vm-0d357714e0867ab67c057652` is RUNNING in `us-central1-a`, machine type `e2-standard-2`.
- Attached retained disk `mapache-ws-efaf283eb879545a0e7ba4d3`: 64 GiB `pd-balanced`. The running VM, retained disk and private networking continue to incur costs. Nothing was stopped or deleted for this handoff.
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
- Transfer, checkpoint assembly and archive extraction passed real child-process SIGKILL/retry tests. A separate synthetic proof interrupted publication on a real GCE Persistent Disk, resumed, then booted the ordinary COS runner with the imported disk. Authenticated `/runner/health` reported the agent ready after startup and the imported executable and history matched. The disposable proof resources were cleaned up. Cloud Function worker crash reconciliation, abrupt VM open-write recovery, ENOSPC and all-format real import remain open.

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

## Checks and continuation

At handoff, the Functions package suite, all seven existing coordinator Firestore emulator cases, lint and docs checks passed. Prior evidence includes 55 focused import and maintenance cases, 281 frontend tests, normal and VM-enabled builds, and synthetic Chrome DevTools routing and editor QA. Full live authenticated frontend acceptance remains open.

```bash
node --test functions/vm*.test.js functions/{sessionLifecycle,cloudRun,sessionCreation,workspaceUploads,sessionResize,workspaceSessionReservation,automationRuns,automationAdmission,automationProvisioning,workspaceRequestRuntime,workspaceAutomationDeletion}.service.test.js
firebase emulators:exec --only firestore --project demo-mapache-cutover 'node --test functions/vmMigrationCoordinator.service.test.js'
npm run docs:check
```

1. For #616, the disposable clone-boot path has passed readiness and cleanup evidence, including empty validation credentials, retry/recovery of the clone identity, lease fencing and ID-checked teardown. A lease deadline does not delete cloud resources. The guarded legacy Functions and Firestore/Storage rules were deployed on 2026-11-24; the remaining live work is deployed-writer drainage, a real cutover canary, and rollback rehearsal after VM writes.
2. Verify deployed legacy writer fencing and drainage, including old upload URIs, outstanding operations and integration bindings. Bind verified source, import and clone evidence to the atomic authority switch, then use the two-phase rollback action to stop the exact destination VM and restore source authority only with a current reverse-import receipt.
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

Remaining: Kill real workers at every cloud-operation/commit boundary; finish pending-operation pagination, startup deadlines, stuck-operation repair, quota/attachment failure recovery and resource-change coordination. File-import SIGKILL tests do not satisfy worker-crash tests.

Fully evidenced original acceptance criteria: 3.

### #612: Partial — live HTTP/WebSocket gateway proof passed

Evidence: Owner/generation/boot/lease checks, fresh agent/shell access and stale-token rejection passed on actual private VMs. Route revocation closed an existing socket in 5.37 seconds; replacement/reconnection was measured. Canonical health is /runner/health.

Remaining: Complete real VM Chrome/VNC/CDP, upload/download and supported preview flows, full cross-owner/guessed-path matrix, reconnect UX, capacity/timeouts and cost measurements. Existing proof does not establish every browser surface.

Fully evidenced original acceptance criteria: 4.

### #613: Not implemented end to end — contract only

Evidence: The intended external scheduler wake-up, request grants, isolated outputs and tool-sharing semantics are documented. Owner-tool source bytes were verified and assembled locally.

Remaining: Implement and verify stopped-target scheduled/Run-now/request wake-up, cancellation, concurrency, read-only inputs, durable outputs, safe idle shutdown, cross-machine tool sharing and correct usage accounting. No full acceptance criterion is met.

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

Remaining: Drain existing writers and make the verified stages available to an eligible production operation. The new `vm-migration-destination-runtime.mjs` action stages a deterministic hidden `vmRuntimes_v2` destination on the exact imported disk, starts the pinned runner, and verifies authenticated `/runner/health`; its cleanup action stops only that staged VM and removes its records while retaining the disk and both fences. The review command then binds the backend-owned destination registry, exact attached disk, pinned runner and health evidence. The follow-on `vm-migration-switch-authority.mjs` action performs the bounded Firestore compare-and-swap: it hides the destination until commit, marks the retained legacy source as VM-owned, keeps both fences, and records destination authority. The separate `vm-migration-reconcile-source.mjs` action rechecks legacy Firestore/Storage and provider absence and records bounded evidence without deleting the source. The `vm-migration-rollback.mjs` action revokes destination admission, stops the exact VM, requires a generation-bound `mapache-reverse-import-v1` receipt, and atomically restores legacy authority while retaining the destination disk. No production workspace has invoked these mutations; live rollback evidence remains open.

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

Remaining: Wire the runtime verifier to an isolated fresh VM and perform a real
fresh-disk/fresh-VM file and runtime verification with measured RPO/RTO;
surface backup/runtime startup, attach, and mount timings and actual costs; and
publish the numeric cost model. The read-only inventory now enumerates owned
Compute instances/disks before any future cleanup. The fail-closed
disk-full/zone-loss procedure is now in
`docs/runbooks/vm-disk-recovery.md`, but its resize and fresh-VM recovery
actions remain unwired. No
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

### #623: Partial — auth/environment selection revisions implemented

Evidence: Owner-scoped auth/environment selection APIs and the opt-in VM modal support stale-save rejection and pending/applied revisions. A paused-save/start live backend proof reached generation 11/config version 1; synthetic editor QA passed without secret disclosure.

Remaining: Finish defaults/inheritance across two machines, full Pi config/MCP/Google/gateway bindings, metadata/resources/disk growth/idle/schedules/cost UX, revocation/disk-restore semantics and full authenticated modal/reconnect QA. Current tests cover only the selected auth/environment subset.

Fully evidenced original acceptance criteria: none; partial evidence does not satisfy the full criterion.

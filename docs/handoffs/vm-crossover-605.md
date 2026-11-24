# VM crossover #605 handoff

Handoff date: 2026-11-23 (America/Chicago). Implementation goal is **paused at the user's request**. Ticket reconciliation and preservation/testing of existing work were authorized for handoff; this does not resume feature implementation.

## Start here

- Parent [#605](https://github.com/rawkintrevo/mapache/issues/605); one draft [PR #629](https://github.com/rawkintrevo/mapache/pull/629).
- Continue branch `605-vm-crossover-isolated-functions`. Do not create another PR, return implementation to main, force-push, merge, or retire legacy operation as part of resuming this work.
- Last implementation commit before handoff packaging: `95c9ee8`. The handoff commit also includes tests and publication of the previously unfinished shared-tree provenance inventory check.
- Rough overall estimate: **45%**, a judgment estimate, not a checklist percentage. No real existing workspace has completed cutover. Every issue stays open; checked criteria below describe scoped evidence, not issue completion.
- [VM Workspaces](../vm-workspaces.md) is the subsystem contract. Some sections describe the intended system; use the issue evidence/remaining matrix below to distinguish it from implemented behavior.

## Authorization and invariants

The user authorized #605 and all 18 children, work on this same branch/PR, and isolated deployments. Prefer new function names ending in `_v2`; preserve existing Cloud Run operation. Implementation remains paused until the user resumes it.

All cloud commands must explicitly target `pi-agents-cloud`. Functions use `mapache-api@pi-agents-cloud.iam.gserviceaccount.com`; runner VMs/services use `mapache-runner@pi-agents-cloud.iam.gserviceaccount.com`. The alternative `mapache-session-runner` identity does not exist. Health is exclusively `/runner/health`. Do not change old writer/provider authority, delete source data, or claim migration based on local import receipts. Do not launch both old and new workspace writers.

The VM paths skip ordinary HOME/workspace/profile checkpoint restore/upload; migration readers are separate. Preserve owner-selected credentials via brokers and avoid copying secrets into public records, manifests or logs. No full real authenticated model turn is yet established.

## Live state rechecked at handoff

- Synthetic workspace `vm-proof-605`, generation 11, registry state `active`, desired configuration version 1, no active operation. `apiEnabled=false`; `lifecycleEnabled=true`.
- Current session: `vm-1977e861d998de7357678d53-g11`.
- VM `mapache-vm-0d357714e0867ab67c057652` is RUNNING in `us-central1-a`, machine type `e2-standard-2`.
- Attached retained disk `mapache-ws-efaf283eb879545a0e7ba4d3`: 64 GiB `pd-balanced`. The running VM, retained disk and private networking continue to incur costs. Nothing was stopped or deleted for this handoff.
- Dedicated gateway: `mapache-vm-gateway-v2`. Isolated VM Functions are separately deployed; legacy Functions were not redeployed for recent migration work. No Hosting deployment for the opt-in VM frontend.
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
- Owner tools: three files/65,988 bytes staged, five directory markers; fixed GCS FUSE 0755 modes captured. Assembly/merging/sharing semantics remain incomplete.
- Transfer, checkpoint assembly and archive extraction passed real child-process SIGKILL/retry tests. These do not establish Cloud Function worker crash reconciliation, abrupt VM open-write recovery, ENOSPC or complete disk import.

Private ignored evidence remains on this workstation under `artifacts/qa/`: `vm-migration-inventory/`, `vm-checkpoint-import/`, `vm-browser-archive-import/`, `vm-browser-profile-proof/`, `vm-owner-tools-import/`, `vm-shared-tree-inventory/{initial,handoff}.json`, `vm-gateway-replacement/`, `vm-lifecycle/`, `vm-owner-api/`, `vm-environment/`, `vm-configuration/` and `vm-client-routing/`.

These directories do **not** travel with Git. They can contain private restored files, filenames, IDs and settings. Do not upload them to the PR or commit them. Use aggregate summaries in docs/issues; arrange secure evidence access or rerun proofs if a new workspace lacks them. Some report writers are create-only; choose a new output path instead of overwriting prior evidence. Frontend screenshots were inspected but connector upload was unavailable; PR records their local paths.

## Code map and checks

- Backend: `functions/vm*.js`, `computeEngine.service.js`, `runtimeProvider*.js`.
- Runner: `session-runner/lib/retainedDiskStorage.js`, `vmRuntimeControl.js`, retained-path config/startup; broker-selected auth/environment.
- Frontend: `src/services/vmWorkspaceApi.js`, `VmWorkspaceEditModal.jsx`, ModalStack routing; `VITE_VM_WORKSPACES_ENABLED=true` opt-in.
- Migration: `scripts/vm-migration-inventory.mjs`; `scripts/lib/vm-{migration-inventory,checkpoint-payloads,storage-metadata,archive-verifier,import-stage,checkpoint-import,import-tree,archive-import,archive-tree,owner-tools-import,shared-tree-authority}.mjs`.
- Source sharing provenance checks only original bucket/marker/control identity. HNS folder inventory, mutable current contents and writer reconciliation remain unverified; never use the legacy ensure/validate service in read-only inventory because it can repair IAM.

Handoff checks: **35 focused migration tests passed**, including four tests for the previously unfinished shared-tree work; the real read-only CLI reports the missing shared bucket and keeps `readyForCutover=false`. Syntax, diff and docs checks are required for the handoff commit. No Functions code changed and no deployment is required.

Re-run focused checks with:

```bash
node --test scripts/lib/vm-shared-tree-authority.test.mjs scripts/lib/vm-owner-tools-import.test.mjs scripts/lib/vm-archive-import.test.mjs scripts/lib/vm-checkpoint-import.test.mjs scripts/lib/vm-import-stage.test.mjs scripts/lib/vm-archive-verifier.test.mjs scripts/lib/vm-checkpoint-payloads.test.mjs scripts/lib/vm-migration-inventory.test.mjs scripts/lib/vm-storage-metadata.test.mjs
npm run docs:check
```

Earlier frontend evidence: 54 test files/281 tests, normal and VM-enabled builds, synthetic CDP routing/editor QA. Those were not rerun for this documentation/read-only inventory handoff. Review each proof's scope before using it to close a requirement.

## Recommended next work after explicit resume

1. Finish source adapters and reconciliation: HNS folders/current shared objects/private Git, owner-tool assembly, source overlap/tombstone handling, unpublished/live-only state. Treat missing sources as explicit cases, not empty filesystems.
2. Prove a complete representative fixture import into a new owned retained disk with no agent/browser writer; include capacity/real ENOSPC, huge files, interrupted initialization and partial cleanup. Validate actual runtime/apps on that disk.
3. Finish #613/#623/#621/#622 compatibility: central settings/defaults/integrations, stopped-machine schedules/requests, headed browser/sandbox, direct resumable uploads and resource edits.
4. Implement exclusive writer freeze/authority switch and lossless rollback after new writes (#616), VM backups/recovery/cost controls (#617), and worker-failure reconciliation.
5. Pass the full #618 release matrix before canary/cohorts (#619). Retire nothing under #620 until reconciliation and retention gates pass.

Continue reporting concrete outcomes and update the individual tickets as work changes. Maintain one PR and distinguish new passing partial checks from full issue completion.

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

Evidence: The intended external scheduler wake-up, request grants, isolated outputs and tool-sharing semantics are documented. Owner-tool source bytes can now be verified/staged locally.

Remaining: Implement and verify stopped-target scheduled/Run-now/request wake-up, cancellation, concurrency, read-only inputs, durable outputs, safe idle shutdown, cross-machine tool sharing and correct usage accounting. No full acceptance criterion is met.

Fully evidenced original acceptance criteria: none; partial evidence does not satisfy the full criterion.

### #614: Partial — registry and several source formats verified

Evidence: Read-only inventory accounted for 85 legacy workspace records plus one isolated VM fixture. It reports IDs/owners/generations and source blockers; selected vm-test checkpoints, browser archive and owner tools were verified. The formerly unfinished shared-tree provenance check is now tested and reports shared_bucket_not_found for the sole shared-tree record.

Remaining: Complete hierarchical folder/current shared-object/private-Git/unpublished/live-only reconciliation, consistent final captures, actual disk sizing, downtime and costs. vm-test HOME recovery is unproven; the shared bucket returns 404. Neither is an empty-source success.

Fully evidenced original acceptance criteria: 1, 3.

### #615: Partial — local resumable recovery tools verified

Evidence: Generation-pinned object staging, per-file/bundle/large-file checkpoint assembly and archive extraction preserve verified bytes, supported modes, links and empty archive directories. Real process-kill recovery passed. vm-test restored 44 checkpoint files and 324 browser files locally; owner tools (3 files/65,988 bytes) are staged.

Remaining: Finish shared-tree/private-Git/all-format support, owner-tool assembly, source merging/authority, new owned-disk import, application/dependency verification, capacity/real ENOSPC/huge-file recovery, initialization interruption and partial-file cleanup. Local receipts are not VM-ready/cutover markers.

Fully evidenced original acceptance criteria: none; partial evidence does not satisfy the full criterion.

### #616: Not implemented — cutover/rollback design only

Evidence: The intended freeze/quiesce/final-capture/import/compare-and-swap/validate state machine is documented. No existing workspace has been cut over and no source has been deleted.

Remaining: Implement the exclusive-writer migration coordinator, crash/race/idempotency tests, owner-visible status and lossless reverse export/rollback after VM writes. Do not flip authority back to a stale checkpoint.

Fully evidenced original acceptance criteria: none; partial evidence does not satisfy the full criterion.

### #617: Not implemented for VM release — policy recorded

Evidence: A daily crash-consistent snapshot/14-day retention target and separate application-consistent migration capture are documented. Normal pause retains the data disk; that is not a backup.

Remaining: Implement VM snapshot scheduling/retention, fresh-disk restore with measured RPO/RTO, ownership-checked deletion/orphan cleanup, retry tests, cost visibility and operational recovery guidance. Existing legacy storage backup code is not VM evidence.

Fully evidenced original acceptance criteria: none; partial evidence does not satisfy the full criterion.

### #618: Partial — isolated proofs, release gate unmet

Evidence: Repeated VM replacements retained the same filesystem without normal full-tree restore. Gateway/owner/API proofs, local migration fault tests and an isolated restored-browser-profile test passed. The current focused migration suite has 35 passing tests.

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



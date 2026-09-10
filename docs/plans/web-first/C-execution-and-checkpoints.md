# Gate C — Execution authority and durable checkpoints

Status: runner-only `pi-chrome` slice implemented; Gate C remains open for
platform fencing, external writers, backend publication enforcement, and the
incomplete Gate A adapter. The production image keeps
`MAPACHE_WEB_FIRST_ENABLED=false`.

Source: [refactor plan v2](../../../refactor-plan-v2.md), Sections 9–10. Requires [Gate B](B-control-and-commands.md) for integration. Run the first feasibility tasks early, after Gate A, to discover platform blockers before extensive implementation. Next: [Gate D](D-canary-and-goals.md).

Goal: prevent overlapping workspace execution and restore one consistent committed recovery point. A junior developer should implement the bounded tasks below with maintainer review of the lease, process-fencing, and publication design. An unsupported platform guarantee is a recorded blocker, not permission to weaken the contract.

## Prove the platform and writer policy first

- [x] C01 — Read [runtime containers](../../runtime-containers.md), [deployment](../../deployment.md), and [runner architecture](../../session-runner-architecture.md). Inspect `workspaceSyncCoordinator.js`, `workspaceArchives.service.js`, `workspace.js`, `shell.js`, and `functions/sessionLifecycle.service.js`.
- [x] C02 — Inventory every workspace writer and publisher: Pi tools/extensions, detached children, shell, preview processes, browser saves, Git operations, periodic/final sync, and legacy runners. Record its entry point, storage destination, credentials, and how it can be stopped or isolated. See [writer inventory](../../../artifacts/web-first/gate-c/writer-inventory.md).
- [ ] C03 — With a maintainer, select a concrete predecessor-termination or resource-fencing mechanism. Build an isolated infrastructure experiment proving a replacement cannot execute while the predecessor is uncertain. Include a stalled supervisor and detached child. Record observed evidence; if this cannot be proved, specify `recovery_required` and leave automatic replacement blocked.
- [ ] C04 — Define a supported checkpoint writer policy using the inventory. Exercise a real development server and a long-running shell writer. Decide which writers can quiesce, which caches are excluded, and which situations block strict checkpoints. Document the user-visible recovery action for a blocked checkpoint.
- [ ] C05 — Measure a representative workspace snapshot and upload, recording bytes, archive duration, upload duration, and time new work is blocked. Have a maintainer assess the cost of checkpointing every independent mutation/task boundary before implementing the full pipeline.

## Implement execution authority

- [x] C06 — Define the workspace execution record with runtime identity, monotonic epoch, lease deadline, and state. Reuse the existing writer reservation domain. Test simultaneous acquisition and prevent legacy/new-mode writers from sharing the same writable recovery domain. The runner boundary is implemented; legacy bypass remains an open C17/C18 platform item.
- [x] C07 — Implement confirmed renewal with an injectable monotonic clock and conservative deadline. An unanswered renewal must not extend authority. Test delayed replies, expiration, revocation, and stale-epoch renewals.
- [x] C08 — Run the watchdog outside Pi's event loop. On authority loss, close command/PTY admission and stop schedulers, tool starts, shell/Git writes, sync, and publication. The runner watchdog and controlled-process response are implemented; live stuck-Pi evidence remains part of C03/C23.
- [x] C09 — Implement the process containment/termination mechanism proven in C03. Exercise child and detached fixture jobs; verify no controlled work survives the stop boundary. Treat termination timeout as unresolved ownership. Controlled child fixtures pass; arbitrary detached children remain outside the claimed boundary.
- [x] C10 — Integrate replacement startup with the predecessor proof. Permit health/read-only preparation before authority, but no automatic Pi work or shell writes. Test that a newer lease record alone never enables conflicting execution. Uncertain predecessors return `recovery_required` and automatic replacement stays blocked.

## Implement checkpoint publication

- [x] C11 — Define versioned manifest and recovery-pointer schemas from v2. Include exact object generations/hashes, Pi session/leaf, workspace revision, prior checkpoint, epoch, and adapter/package versions. Add schema and invalid-binding tests.
- [ ] C12 — Implement a shared mutation/checkpoint barrier covering C02's included writers. Runner-owned browser/file sync, Git, shell, and managed continuation boundaries are covered; browser-side Functions writes and arbitrary detached work are still outside the shared barrier.
- [ ] C13 — Use the proven adapter to capture a complete session tree, valid active leaf, and managed goal state. Capture immutable local copies with included workspace/Git data. Test transcript mutation during capture and validate the captured IDs before upload. The current adapter lacks canonical session export/path and Gate A remains incomplete.
- [x] C14 — Implement a snapshot allowlist excluding credentials, control tokens, IPC files, and reconstructible caches. Test with fixture secrets and unrelated Chrome state; excluded values must not appear in the archive or manifest.
- [x] C15 — Upload payloads under immutable epoch/checkpoint paths with create-only preconditions. Verify generations, lengths, and hashes; upload the manifest last. Deterministic duplicate/precondition and failed-upload checks pass; live late-completion-after-cancellation evidence remains open with C23.
- [ ] C16 — Add a backend-controlled publisher. The runner-controlled transaction validates epoch, workspace authority/revision, prior checkpoint, and manifest references, but Functions/backend-only enforcement and transaction-retry fault evidence are still required.
- [ ] C17 — Route periodic sync, final sync, manual file updates, and Git snapshots through the new-mode publication policy. Audit for direct canonical overwrites, including legacy writers. Verify a delayed old upload can create only an orphan, never change the committed pointer.
- [ ] C18 — Audit runtime/API permissions with a maintainer so the runner cannot bypass the publisher's canonical pointer checks. Preserve `mapache-api@pi-agents-cloud.iam.gserviceaccount.com` and `mapache-runner@pi-agents-cloud.iam.gserviceaccount.com`; document actual enforced boundaries rather than claiming cooperative checks are a sandbox.
- [x] C19 — Establish an initial checkpoint before a new conversation's first mutating run. Require committed checkpoints before the next independent mutation and at supported goal task boundaries. Expose execution-finished and saved separately; runner checkpoint failure leaves inspection/stop/recovery available while new root mutations remain blocked.

## Restore, inject faults, and close the gate

- [x] C20 — Restore only the exact committed manifest generations and paired transcript/goal/workspace snapshot. Verification and staging restore reject missing objects, checksum mismatch, invalid leaf, and incompatible bindings without newest-file guessing; live fault coverage remains open in C23.
- [ ] C21 — Implement explicit rollback to an earlier verified paired checkpoint. Keep operation tombstones outside rollback. Test an old command retry after rollback and report the affected operation range without redispatch.
- [x] C22 — Add orphan cleanup with a grace period and reference check. Cleanup protects the committed pair and refuses to run during a pending publication; live race evidence remains open in C23.
- [ ] C23 — Automate crashes before upload, after payloads, after manifest, and after pointer commit. Verify the expected checkpoint remains authoritative at each point. Repeat with lease loss, publication outage, and predecessor uncertainty.
- [ ] C24 — Verify the configured background CPU/continuation policy using the target runner with all browser sockets closed. Use explicit `--project pi-agents-cloud` on cloud commands and isolated test resources. Record cleanup and distinguish measured behavior from platform assumptions.
- [x] C25 — Run relevant runner/Functions tests and lint, then `npm run check`. Follow repo Functions deployment requirements when backend code changes. Save fault evidence and performance measurements under `artifacts/web-first/gate-c/`; update runtime, deployment, and recovery docs and run `npm run docs:check`. Local checks pass and the Gate C artifacts record the runner-only scope; live platform/fault/performance evidence remains open in C03/C05/C23/C24.

## Exit criteria

A maintainer can reproduce predecessor fencing and each publication/restore fault result. All canonical writers obey the policy, committed snapshots restore as a pair, and uncertain effects remain explicit. Failed feasibility, unacceptable checkpoint blocking, or an uncontrolled writer keeps Gate C open and production replacement disabled.

# Task 13: Fence duplicate and stale runner instances

Difficulty: medium. Depends on Tasks 1–12. Implementation status is tracked only in [the root checklist](../../../task_list.md).

## Goal and starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then inspect:

- `functions/syncWriterLease.service.js`
- `session-runner/lib/workspaceSyncCoordinator.js`
- `docs/plans/pi-web-ui-tasks/contracts.md`

Paths above are repository-relative. Upstream paths referenced below are relative to the pinned source prepared in Task 2. Read focused wiki pages before editing their owners.

## Ownership

Focused runner authority helper and small existing coordination-service extensions.

## Steps

1. Add per-boot instance ownership within the reserved runtime generation. Acquire authority before launching upstream or enabling writes.
2. Make duplicate boot admission fail closed; authorize a successor only after the predecessor is positively fenced through the controlled lifecycle.
3. Expose a reusable assertCurrentWriter operation for checkpoint/file publication and runtime command admission.
4. On lost authority or indeterminate renewal, reject new work, terminate the agent/tool process group, and prevent publication. Use bounded existing coordination calls.
5. Document the physical-container versus admitted-writer distinction and wire a deterministic two-instance fixture.

## Acceptance criteria

Use two deterministic fake instances A and B and a controllable coordination
store. Required sequence: A acquires generation 1; B is denied; a confirmed
stop/recreate advances to generation 2; B acquires it; A's delayed work/publication
callback is denied. A second test removes coordination access while A is running
and verifies it stops admitting work and terminates its child group. This is a
single-workspace lifecycle guard, not a general distributed worker scheduler.

- Two boot instances cannot both become admitted writers for one workspace generation.
- Revocation stops new work and stale callbacks cannot publish through assertCurrentWriter.
- Uncertain predecessor state blocks replacement instead of promoting based solely on a sleep/timeout.

## Validation

Runner/Functions coordination tests including delayed callbacks, duplicate boot, revoked generation, and process termination; required Functions deploy if changed.

Update the affected canonical wiki page for behavior changes and run `npm run docs:check`. Apply the execution guide's deployment and commit rules.

## Boundary and stop conditions

No new generic operation ledger, multi-agent scheduler, or terminal-to-RPC handoff system. The shared stop conditions apply; do not skip this task if access or an acceptance gate is blocked.

## Handoff

Add a short Completed or Blocked note under Task 13 in the root checklist. Record actual owner paths, commands/results, non-secret evidence references, and any contract refinements needed by Task 14. Check the box only after all criteria pass.

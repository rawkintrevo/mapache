# Task 19: Schedule saves and require a final checkpoint on manual Stop

Difficulty: medium. Depends on Tasks 1–18. Status lives in [the root checklist](../../../task_list.md).

## Starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then these repository-relative paths:

- `session-runner/lib/workspaceSyncCoordinator.js`
- `session-runner/lib/runnerLifecycle.js`
- `docs/plans/pi-web-ui-tasks/contracts.md`

Inspect actual owner code and predecessor handoffs before editing. Upstream paths refer to the pinned source from Task 2.

## Ownership

Checkpoint scheduler and existing stop lifecycle composition.

## Steps

1. Wire 30-second workspace saves, 60-second agent saves, and debounced completed-turn agent saves into a serialized queue with injectable clocks.
2. Implement manual stop in order: quiesce/confirm writers stopped, final snapshot capture/publication, then acknowledge readiness for service deletion.
3. Enforce the 120-second manual-save budget and expose stop/checkpoint errors without claiming success. Do not allow automatic restart from stop_failed.
4. Handle Cloud Run SIGTERM as best-effort within its actual deadline, retaining the last completed checkpoint as the recovery boundary.
5. Ensure preview/Chrome-related source writers cannot race a final workspace capture; serialize their shutdown/capture where relevant.

## Acceptance criteria

- Overlapping periodic/turn/stop saves serialize, and the final save is never silently skipped.
- Storage failure yields a visible failed Stop and blocks replacement.
- Graceful restart includes final data; forced termination restores the last completed checkpoint without claiming zero data loss.

## Validation

Fake-clock scheduler tests, stop order/failure tests, and local restart/forced-loss integration.

Update the affected canonical wiki page for behavior changes and run `npm run docs:check`. Follow the execution guide's deployment and commit rules.

## Boundary and stop conditions

No infinite save retry, silent force-stop fallback, or invented exact crash-loss guarantee. Shared stop conditions apply; leave the root checkbox unchecked on any blocked acceptance criterion.

## Handoff

Record actual paths, commands/results, safe evidence references, and contract changes under Task 19 in the root checklist. Commit the completed task before continuing to Task 20.


# Task 17: Restore native Goal information in a paused state

Difficulty: medium. Depends on Tasks 1–16. Status lives in [the root checklist](../../../task_list.md).

## Starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then these repository-relative paths:

- `docs/workspace-goals.md`
- `docs/plans/pi-web-ui-tasks/contracts.md`

Inspect actual owner code and predecessor handoffs before editing. Upstream paths refer to the pinned source from Task 2.

## Ownership

Small upstream goal-service/client-state persistence patch and regression tests.

## Steps

1. Inspect actual native Goal persistence, then add only missing serialization of goal text, preferences, and last visible status keyed by conversation identity.
2. Save goal display state in the UI data captured by Task 14. Do not persist pending wizard/review execution as runnable jobs.
3. Restore active-at-shutdown goals as paused/interrupted and provide the normal explicit user action to resume.
4. Keep goal status scoped to the correct conversation across tab switches and fresh browser client IDs.

## Acceptance criteria

- Goal text/preferences survive container restart and remain attached to the original conversation.
- Restart/reconnect/history-open sends zero automatic wizard/review/model requests.
- Explicit resume works through the upstream native Goal path without Mapache Goals APIs or pi-goal-x.

## Validation

Upstream goal persistence/restart/conversation tests using a deterministic fake model; build/typecheck.

Update the affected canonical wiki page for behavior changes and run `npm run docs:check`. Follow the execution guide's deployment and commit rules.

## Boundary and stop conditions

No durable Goal scheduler, old Goal-state converter, or automatic task execution after restore. Shared stop conditions apply; leave the root checkbox unchecked on any blocked acceptance criterion.

## Handoff

Record actual paths, commands/results, safe evidence references, and contract changes under Task 17 in the root checklist. Commit the completed task before continuing to Task 18.


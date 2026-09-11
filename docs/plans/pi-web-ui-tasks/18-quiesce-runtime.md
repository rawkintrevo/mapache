# Task 18: Stop upstream agent and tool writers through a narrow control hook

Difficulty: medium. Depends on Tasks 1–17. Status lives in [the root checklist](../../../task_list.md).

## Starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then these repository-relative paths:

- `session-runner/lib/runnerLifecycle.js`
- `docs/plans/pi-web-ui-tasks/contracts.md`

Inspect actual owner code and predecessor handoffs before editing. Upstream paths refer to the pinned source from Task 2.

## Ownership

Upstream managed lifecycle patch and piWebUiProcess adapter.

## Steps

1. Implement authenticated local quiesce/activity operations using upstream control facilities where possible.
2. Quiesce rejects new prompts, new execution, terminal writes, and Goal starts; abort active agent/Goal/tool work and drain state writes.
3. Stop the process group on the contract's bounded escalation schedule if cooperative termination stalls. Confirm exit before acknowledging the writers are stopped.
4. Expose safe activity/health counters independent of connected browsers. Keep read-only display/status available until final shutdown where practical.

## Acceptance criteria

- New execution is rejected after quiesce even with a direct protocol message.
- Blocked tool/Goal fixtures terminate or return a visible bounded failure; no premature quiesce acknowledgement.
- Activity reflects background conversations without browser sockets.

## Validation

Runner/upstream tests for active tools, delayed completion, blocked shutdown, process descendants, and direct command admission.

Update the affected canonical wiki page for behavior changes and run `npm run docs:check`. Follow the execution guide's deployment and commit rules.

## Boundary and stop conditions

Do not infer completion from a browser close event, terminal rendering, or a timer alone. Shared stop conditions apply; leave the root checkbox unchecked on any blocked acceptance criterion.

## Handoff

Record actual paths, commands/results, safe evidence references, and contract changes under Task 18 in the root checklist. Commit the completed task before continuing to Task 19.


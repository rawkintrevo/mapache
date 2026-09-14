# Task 22: Verify the complete local runtime before cloud rollout

Difficulty: medium. Depends on Tasks 1–21. Status lives in [the root checklist](../../../task_list.md).

## Starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then these repository-relative paths:

- `docs/testing.md`
- `docs/plans/pi-web-ui-tasks/contracts.md`

Inspect actual owner code and predecessor handoffs before editing. Upstream paths refer to the pinned source from Task 2.

## Ownership

Local deterministic integration fixtures and a sanitized Task 22 evidence summary.

## Steps

1. Run the built pi-chrome runtime with fake cloud boundaries and a deterministic model/MCP fixture, exercising the real upstream server and gateway.
2. Cover streamed messages, tools, file edit, history listing, multiple conversations, shell, native Goal, token renewal, Chrome/Preview health, checkpoint/restart, and no automatic resume.
3. Exercise concurrent admission and stale-publication rejection through the actual composed modules, not only isolated mocks.
4. Run npm run check once the composed behavior passes; fix failures within existing task boundaries and update earlier handoffs if a contract correction is necessary.

## Acceptance criteria

- The integrated local image works across the agreed user flow with no paid model dependency.
- No duplicate execution occurs on renewal/reconnect; restored state is usable and paused.
- Aggregate checks pass with evidence tied to the source commit and image build inputs.

## Validation

Deterministic local integration suite, npm run check, and local image smoke; record exact commands and results.

Update the affected canonical wiki page for behavior changes and run `npm run docs:check`. Follow the execution guide's deployment and commit rules.

## Boundary and stop conditions

Do not mark this as hosted/browser QA or proceed with a known integration failure. Shared stop conditions apply; leave the root checkbox unchecked on any blocked acceptance criterion.

## Handoff

Record actual paths, commands/results, safe evidence references, and contract changes under Task 22 in the root checklist. Commit the completed task before continuing to Task 23.


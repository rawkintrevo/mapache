# Task 28: Run hosted persistence and failure-recovery QA

Difficulty: medium. Depends on Tasks 1–27. Status lives in [the root checklist](../../../task_list.md).

## Starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then these repository-relative paths:

- `docs/plans/pi-web-ui-tasks/contracts.md`
- `.agents/skills/qa-test/SKILL.md`

Use actual paths/IDs from prior task evidence, not guessed names. Read focused wiki pages before editing code.

## Ownership

Task 25 fault manifests, deterministic runner fixtures, and Task 28 evidence.

## Steps

1. Close all UI connections during a bounded background fixture and prove runtime progress continues; reconnect without starting duplicate work.
2. Race Start requests and inject duplicate/stale writer instances against disposable state, proving only one admitted writer and no stale publication.
3. Exercise manual Stop final-save success/failure, restart, resize, failed old-service deletion, and revoked auth while a WebSocket is open.
4. Force-loss a canary container after a recorded checkpoint, then exercise the documented recovery path. Verify files/history/settings/Goal display restore without automatic execution.
5. Test upload interruption and stale file deletion against the real staging/pointer boundary, with no writes to the source workspace.

## Acceptance criteria

- All failure cases end in their specified bounded state, not an infinite retry/spinner.
- Manual stop never reports a failed checkpoint as saved; forced recovery reports its checkpoint boundary.
- No two admitted writers or silently resumed turns occur, and the untouched source still works.

## Validation

Hosted lifecycle/fault manifests plus sanitized cloud/state evidence; run aggregate checks if fixes changed implementation.

Update affected canonical docs for behavior changes and run `npm run docs:check`. Follow the execution guide's deployment and commit rules.

## Boundary and stop conditions

Do not weaken failure assertions or run injected outages on HubSpot. All shared stop conditions apply. Leave this task unchecked if any required check fails or access is missing.

## Handoff

Record actual commands/results, safe evidence references, and any recovery actions under Task 28 in the root checklist. Commit before continuing to Task 29.


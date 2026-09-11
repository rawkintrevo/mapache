# Task 37: Clean up QA resources and close the implementation checklist

Difficulty: easy. Depends on Tasks 1–36. Status lives in [the root checklist](../../../task_list.md).

## Starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then these repository-relative paths:

- `docs/plans/pi-web-ui-tasks/README.md`

Use actual paths/IDs from prior task evidence, not guessed names. Read focused wiki pages before editing code.

## Ownership

Recorded QA resources, root checklist completion notes, final release summary.

## Steps

1. Stop/delete only the canary/rehearsal services and QA workspaces recorded in this run. Keep production HubSpot and all migration originals/backups.
2. Record final production source revision/digest, backup references, checks passed, rollback command locations, and any operational limitations without secret/transcript content.
3. Verify all prior checkboxes have actual acceptance evidence and no Blocked note is being counted as complete.
4. Commit the final docs/cleanup evidence summary and report the finished goal, preserving unrelated user changes.

## Acceptance criteria

- No recorded disposable service is left consuming compute; unrelated resources are untouched.
- The HubSpot files/history recovery path remains available.
- Every task has passed evidence and the final working tree status is accurately reported.

## Validation

Read-only cloud resource checks by exact recorded IDs, git status, npm run docs:check, and checklist audit.

Update affected canonical docs for behavior changes and run `npm run docs:check`. Follow the execution guide's deployment and commit rules.

## Boundary and stop conditions

Do not delete old user data, migration backups, or remote images as cleanup. All shared stop conditions apply. Leave this task unchecked if any required check fails or access is missing.

## Handoff

Record actual commands/results, safe evidence references, and any recovery actions under Task 37 in the root checklist. Report completion only if every previous task also passed.


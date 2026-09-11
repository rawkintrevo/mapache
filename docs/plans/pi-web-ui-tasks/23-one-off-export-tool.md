# Task 23: Build the one-off HubSpot export and manifest tool

Difficulty: medium. Depends on Tasks 1–22. Status lives in [the root checklist](../../../task_list.md).

## Starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then these repository-relative paths:

- `session-runner/lib/config.js`
- `session-runner/lib/workspaceArchives.service.js`
- `docs/plans/pi-web-ui-tasks/contracts.md`

Inspect actual owner code and predecessor handoffs before editing. Upstream paths refer to the pinned source from Task 2.

## Ownership

A small scripts/migrations/pi-web-ui-hubspot export command and fixture tests.

## Steps

1. Consume the exact restricted inventory from Task 1. Require explicit source IDs and output prefix; default to inspection/dry-run.
2. Export all workspace files, hidden files and .git if present, plus the selected session's complete Pi JSONL history. Include readable large attachments referenced by that history when they are part of the selected files/history.
3. Exclude Chrome profile/tabs/login state and other sessions. Do not infer that the newest cloud archive includes latest live source data.
4. Implement consistent capture using the source runner's actual quiesce/stop capability established in Task 1, producing a checksummed immutable manifest and restricted backup. Prepare the procedure here; do not touch the live source yet.
5. Reject writes to the source prefix and unsafe archive paths. Preserve original bytes and note any incomplete final JSONL record rather than discarding it silently.

## Acceptance criteria

- Fixtures cover nested/hidden files, .git, non-UTF8 file bytes, branches, attachments, and source-ID mismatch.
- Export refuses a non-quiescent final capture or source/output prefix collision.
- The command is specific to the one migration and records every copied/skipped path with a reason.

## Validation

Fixture export tests and dry-run against read-only metadata; no live source stop or data movement.

Update the affected canonical wiki page for behavior changes and run `npm run docs:check`. Follow the execution guide's deployment and commit rules.

## Boundary and stop conditions

Do not build bulk migration, copy credentials to Git, or mutate the sole source in this task. Shared stop conditions apply; leave the root checkbox unchecked on any blocked acceptance criterion.

## Handoff

Record actual paths, commands/results, safe evidence references, and contract changes under Task 23 in the root checklist. Commit the completed task before continuing to Task 24.


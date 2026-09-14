# Task 24: Import and validate HubSpot files and history

Difficulty: medium. Depends on Tasks 1–23. Status lives in [the root checklist](../../../task_list.md).

## Starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then these repository-relative paths:

- `docs/plans/pi-web-ui-tasks/contracts.md`

Inspect actual owner code and predecessor handoffs before editing. Upstream paths refer to the pinned source from Task 2.

## Ownership

Companion import/verify commands under scripts/migrations/pi-web-ui-hubspot.

## Steps

1. Require a verified Task 23 backup and an explicitly isolated target; reject source-target identity/prefix overlap.
2. Copy files and JSONL into the fixed new layout. Preserve transcript IDs/branches/content and use the SDK's actual list/open functions to validate history discovery.
3. Apply only necessary recorded managed-config transformations, including removal of conflicting pi-goal-x launch declarations, without editing the immutable original.
4. Generate a comparison report listing hashes/counts, intentional configuration differences, and any errors. Make rerun idempotent on an empty/rehearsal target and refuse overwriting new user work.
5. Support a verify-only mode for final cutover and rollback evidence.

## Acceptance criteria

- All fixture files/history validate, and imported histories open without automatic model execution.
- No transcript is silently dropped or reauthored; an unsupported/corrupt format blocks the import.
- Idempotent repeat yields the same result; target containing new work is protected.

## Validation

Export-to-import roundtrip fixtures, SDK discovery/open tests, checksum/path/symlink/collision tests.

Update the affected canonical wiki page for behavior changes and run `npm run docs:check`. Follow the execution guide's deployment and commit rules.

## Boundary and stop conditions

No conversion of Codex/SSH history or old Goal execution state. Shared stop conditions apply; leave the root checkbox unchecked on any blocked acceptance criterion.

## Handoff

Record actual paths, commands/results, safe evidence references, and contract changes under Task 24 in the root checklist. Commit the completed task before continuing to Task 25.


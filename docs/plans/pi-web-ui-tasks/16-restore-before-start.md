# Task 16: Restore saved state before starting the agent

Difficulty: medium. Depends on Tasks 1–15. Status lives in [the root checklist](../../../task_list.md).

## Starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then these repository-relative paths:

- `session-runner/lib/workspaceArchives.service.js`
- `session-runner/lib/runnerLifecycle.js`
- `docs/plans/pi-web-ui-tasks/contracts.md`

Inspect actual owner code and predecessor handoffs before editing. Upstream paths refer to the pinned source from Task 2.

## Ownership

Focused checkpoint restore helper and runner bootstrap composition.

## Steps

1. Read only the published manifests, download into staging, validate every checksum/path, and atomically install validated state before runtime admission.
2. Restore workspace files and agent state to the fixed directories; rematerialize credentials after config restore and before upstream launch.
3. Leave new workspaces empty/default when no snapshot exists. Treat corrupt or partial snapshots as a visible startup failure, preserving the last good data.
4. Disable old writers for state paths owned by the new snapshot path. Opening restored history must not trigger model execution.

## Acceptance criteria

- A new container restores files, nested/hidden entries, history, settings, and attachments from a good checkpoint.
- Corrupt, missing, unsafe, or mixed-generation data cannot partially replace a good restore.
- A restored conversation can be opened with zero model requests until explicit prompt/resume.

## Validation

Runner restore integration tests with temporary directories and fake cloud objects; local image restart test without a paid model.

Update the affected canonical wiki page for behavior changes and run `npm run docs:check`. Follow the execution guide's deployment and commit rules.

## Boundary and stop conditions

Do not silently fall back to an empty workspace on restore failure. Shared stop conditions apply; leave the root checkbox unchecked on any blocked acceptance criterion.

## Handoff

Record actual paths, commands/results, safe evidence references, and contract changes under Task 16 in the root checklist. Commit the completed task before continuing to Task 17.


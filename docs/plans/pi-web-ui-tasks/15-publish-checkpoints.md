# Task 15: Publish checkpoints without stale-writer overwrite

Difficulty: medium. Depends on Tasks 1–14. Status lives in [the root checklist](../../../task_list.md).

## Starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then these repository-relative paths:

- `session-runner/lib/workspaceSyncGeneration.helpers.js`
- `session-runner/lib/workspaceSyncCoordinator.js`
- `docs/plans/pi-web-ui-tasks/contracts.md`

Inspect actual owner code and predecessor handoffs before editing. Upstream paths refer to the pinned source from Task 2.

## Ownership

Agent checkpoint publisher and existing file-sync writer checks.

## Steps

1. Upload Task 14 captures to unique immutable object names; publish a manifest pointer only after all uploads validate and writer authority is checked transactionally.
2. Use the existing metadata identity and generation-precondition helpers. Do not mix new state with legacy source archive keys.
3. Audit all existing workspace file-sync upload/delete paths. For the new runtime, stage versioned file writes and commit them through current-writer publication when a direct mutable write could outlive revocation.
4. Make stale writers and partial uploads leave the last good pointer intact. Ensure restore can use the published file manifest rather than a stale flat listing.
5. Expose lastCheckpointAt/checkpointError safely; do not add automatic snapshot garbage collection in this task.

## Acceptance criteria

Implement in these bounded increments, each with its own failing test first:

1. `uploadCapture`: take a Task 14 manifest and return immutable object references; no pointer mutation. Test partial failure leaves the previous pointer unchanged.
2. `commitCheckpoint`: read generation/boot authority and atomically write the references in the same Firestore transaction. Test revocation after upload but before commit rejects publication.
3. `publishWorkspaceFiles`: reuse the manifest/publication primitives for new-runtime file content and tombstones. Keep the legacy writer only for unmarked workspaces. Test a delayed old delete cannot remove a file from a newer published manifest.
4. Wire safe status updates and the existing sync coordinator; keep scheduled capture/stop logic for Task 19.

Do not replace the last step with a token check immediately before a mutable
upload. Revocation can occur while that upload is in flight. The authoritative
file view must come from the successfully committed manifest.

- Injected partial upload never replaces the previous checkpoint.
- A writer revoked between upload and pointer publication cannot publish.
- Delayed old workspace file upload/delete cannot overwrite or hide a successor's published files; tests cover files as well as agent state.

## Validation

Mock Storage/Firestore tests with revoked generations, concurrent publication, upload failure, stale deletes, and successful commit; required Functions deployment if coordination changes.

Update the affected canonical wiki page for behavior changes and run `npm run docs:check`. Follow the execution guide's deployment and commit rules.

## Boundary and stop conditions

Reuse coordination from Tasks 12–13. Do not weaken stale-file checks to pass only an agent snapshot test. Shared stop conditions apply; leave the root checkbox unchecked on any blocked acceptance criterion.

## Handoff

Record actual paths, commands/results, safe evidence references, and contract changes under Task 15 in the root checklist. Commit the completed task before continuing to Task 16.

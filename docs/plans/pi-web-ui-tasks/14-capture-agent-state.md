# Task 14: Capture versioned agent-state snapshots

Difficulty: medium. Depends on Tasks 1–13. Status lives in [the root checklist](../../../task_list.md).

## Starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then these repository-relative paths:

- `session-runner/lib/workspaceArchives.service.js`
- `session-runner/lib/config.js`
- `docs/plans/pi-web-ui-tasks/contracts.md`

Inspect actual owner code and predecessor handoffs before editing. Upstream paths refer to the pinned source from Task 2.

## Ownership

New focused agent snapshot capture/manifest helper and tests.

## Steps

1. Define manifest version 1 using the shared contract and record the exact internal storage prefix derived from existing workspace storage configuration.
2. Capture Pi transcripts, non-secret Pi settings, upstream UI settings, and referenced uploads into a staging directory; use relative paths and SHA-256 checksums.
3. Copy only complete JSONL records during live saves and detect concurrent changes to JSON/settings before accepting a capture. Preserve complete history, not only visible recent messages.
4. Exclude rematerialized auth, connector secrets, lock files, caches, and process state through explicit rules. Preserve actual attachments needed by old messages.
5. Reject traversal and unsafe symlink extraction; document how safe workspace symlinks are preserved without following them outside the source.

## Acceptance criteria

- Fixture snapshot restores a complete inventory of intended persistent state without secrets/caches.
- Concurrent append or JSON replacement cannot produce an accepted malformed snapshot.
- Manifest includes generation/instance identity and checksums; no remote publication occurs in capture.

## Validation

Runner capture tests for partial JSONL, attachment references, changed files, permissions, symlinks, and exclusions; runner lint.

Update the affected canonical wiki page for behavior changes and run `npm run docs:check`. Follow the execution guide's deployment and commit rules.

## Boundary and stop conditions

Do not build cloud upload, restore, or a general backup product. Shared stop conditions apply; leave the root checkbox unchecked on any blocked acceptance criterion.

## Handoff

Record actual paths, commands/results, safe evidence references, and contract changes under Task 14 in the root checklist. Commit the completed task before continuing to Task 15.


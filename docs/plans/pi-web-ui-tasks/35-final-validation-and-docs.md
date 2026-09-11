# Task 35: Validate the final code and reconcile developer documentation

Difficulty: medium. Depends on Tasks 1–34. Status lives in [the root checklist](../../../task_list.md).

## Starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then these repository-relative paths:

- `docs/README.md`
- `docs/wiki-update-protocol.md`
- `docs/testing.md`

Use actual paths/IDs from prior task evidence, not guessed names. Read focused wiki pages before editing code.

## Ownership

Canonical subsystem docs, focused regression fixes, and release acceptance summary.

## Steps

1. Run npm run check on the final code after legacy removal and a clean reproducible pi-chrome image build.
2. Rerun hosted core/lifecycle cases affected by retirement on the final candidate digest, using the existing bounded QA manifests.
3. Reconcile frontend/backend/runtime/harness/Goals/UI/testing/deployment docs with actual behavior. Mark superseded plans as historical; keep this checklist's progress truthful.
4. Check every fixed decision and contract against actual owner paths and passing evidence; record any unresolved limitation instead of calling the release complete.
5. Prepare final immutable image digest, API/frontend source revision, rollout commands, and tested rollback references.

## Acceptance criteria

- Aggregate, image and required final-candidate QA checks pass.
- Canonical docs describe the implemented one-runner system and link to actual owners.
- There is no unchecked technical gate or unresolved product choice hidden in a completion note.

## Validation

npm run check, clean image build, affected hosted QA, and checklist-to-evidence review.

Update affected canonical docs for behavior changes and run `npm run docs:check`. Follow the execution guide's deployment and commit rules.

## Boundary and stop conditions

No broad unrelated docs/community refactor or skipping failed tests to reach release. All shared stop conditions apply. Leave this task unchecked if any required check fails or access is missing.

## Handoff

Record actual commands/results, safe evidence references, and any recovery actions under Task 35 in the root checklist. Commit before continuing to Task 36.


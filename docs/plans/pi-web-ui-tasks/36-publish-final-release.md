# Task 36: Publish and verify the final one-runner release

Difficulty: medium. Depends on Tasks 1–35. Status lives in [the root checklist](../../../task_list.md).

## Starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then these repository-relative paths:

- `docs/deployment.md`
- `docs/plans/pi-web-ui-tasks/35-final-validation-and-docs.md`

Use actual paths/IDs from prior task evidence, not guessed names. Read focused wiki pages before editing code.

## Ownership

Existing release/deploy tooling and restricted final deployment record.

## Steps

1. Publish/promote only the Task 35 validated immutable digest to the intended pi-chrome production reference; record tag and digest.
2. Deploy final Functions before primary Hosting using explicit --project pi-agents-cloud. Deploy any other touched named Functions resources as required by the actual diff.
3. If the migrated HubSpot container needs the final image, use its tested stop/final-save/recreate lifecycle; do not bypass it with a rolling service update.
4. Run a production login/new-workspace/Agent/Chrome/Preview smoke, then verify HubSpot files/history and paused explicit-resume behavior without real connector mutations.
5. On regression, execute the documented release rollback after stopping the new writer and preserving post-cutover work; stop the checklist.

## Acceptance criteria

- Production Hosting/API/runtime align on the tested source and digest, with correct service accounts.
- HubSpot remains usable and new workspaces provision only pi-chrome.
- Commands, revisions, hashes and production smoke results are recorded; no release claim rests only on a preview test.

## Validation

Production smoke manifests, service-template/digest inspection, migration verify-only check, and safe auth/access tests.

Update affected canonical docs for behavior changes and run `npm run docs:check`. Follow the execution guide's deployment and commit rules.

## Boundary and stop conditions

Do not overwrite post-migration files/history with the original backup or deploy an untested rebuilt image. All shared stop conditions apply. Leave this task unchecked if any required check fails or access is missing.

## Handoff

Record actual commands/results, safe evidence references, and any recovery actions under Task 36 in the root checklist. Commit before continuing to Task 37.


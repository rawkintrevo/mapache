# Task 12: Serialize workspace Start requests

Difficulty: medium. Depends on Tasks 1–11. Implementation status is tracked only in [the root checklist](../../../task_list.md).

## Goal and starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then inspect:

- `functions/sessionCreation.service.js`
- `functions/syncWriterLease.service.js`
- `functions/syncWriterLease.helpers.js`

Paths above are repository-relative. Upstream paths referenced below are relative to the pinned source prepared in Task 2. Read focused wiki pages before editing their owners.

## Ownership

Existing workspace/session reservation helpers and tests.

## Steps

1. Extend existing writer coordination with runtimeGeneration and the server-owned new-runtime marker; write the exact field mapping into contracts.md.
2. Make concurrent Start/create requests converge transactionally on one session/service, retaining existing operation-id idempotency.
3. Reject a second new-runtime session while one is starting/running/stopping, including requests using different operation IDs.
4. Keep all behavior gated for marked workspaces and deploy compatible Functions changes.

## Acceptance criteria

- Concurrent calls with equal or different operation IDs yield at most one admitted logical runner.
- A failed attempt can be retried deterministically without stealing another operation's reservation.
- Unmarked HubSpot source is unchanged and Functions deploy/compatibility smoke pass.

## Validation

Focused Functions transaction/race/idempotency tests, lint, required Functions deploy and source compatibility smoke.

Update the affected canonical wiki page for behavior changes and run `npm run docs:check`. Apply the execution guide's deployment and commit rules.

## Boundary and stop conditions

Do not implement boot-instance fencing or rewrite Cloud Run replacement here. The shared stop conditions apply; do not skip this task if access or an acceptance gate is blocked.

## Handoff

Add a short Completed or Blocked note under Task 12 in the root checklist. Record actual owner paths, commands/results, non-secret evidence references, and any contract refinements needed by Task 13. Check the box only after all criteria pass.


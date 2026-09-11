# Task 30: Move the HubSpot workspace to the validated runner

Difficulty: medium. Depends on Tasks 1–29. Status lives in [the root checklist](../../../task_list.md).

## Starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then these repository-relative paths:

- `docs/plans/pi-web-ui-tasks/29-rehearse-hubspot-migration.md`
- `docs/plans/pi-web-ui-tasks/contracts.md`

Use actual paths/IDs from prior task evidence, not guessed names. Read focused wiki pages before editing code.

## Ownership

One-off migration script execution and restricted release/rollback record.

## Steps

1. Use the passing image digest and exact source IDs. Quiesce the source and perform a fresh final export to include changes since rehearsal.
2. Verify that backup before changing the workspace marker/runtime mapping. Confirm the old source service is stopped/deleted before enabling the new writer.
3. Retain workspace/session identity and Mapache connection bindings; restore files/history into the new versioned prefix and start pi-chrome under the new generation.
4. Verify manifest hashes, history/branch counts, representative messages, and one explicit inert resume through the authenticated preview UI.
5. If any migration assertion fails, stop the new writer, preserve any new work separately, restore the previous mapping/image/data from the recorded backup, and stop the run after this single attempt.

## Acceptance criteria

- HubSpot files and complete selected Pi history are usable in the new runtime; no browser state was imported.
- Only one writer has the workspace's live authority and old source data remains recoverable.
- Passing migration evidence or executed rollback is recorded; failed cutover remains unchecked.

## Validation

Final export/import comparison, browser verification, runtime ownership check, and exact rollback readiness record.

Update affected canonical docs for behavior changes and run `npm run docs:check`. Follow the execution guide's deployment and commit rules.

## Boundary and stop conditions

No general migration, deleting backups, rewriting transcripts, or repeated retries against the sole source. All shared stop conditions apply. Leave this task unchecked if any required check fails or access is missing.

## Handoff

Record actual commands/results, safe evidence references, and any recovery actions under Task 30 in the root checklist. Commit before continuing to Task 31.


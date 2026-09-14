# Task 29: Rehearse the one-off migration from a consistent source backup

Difficulty: medium. Depends on Tasks 1–28. Status lives in [the root checklist](../../../task_list.md).

## Starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then these repository-relative paths:

- `docs/plans/pi-web-ui-tasks/23-one-off-export-tool.md`
- `docs/plans/pi-web-ui-tasks/24-one-off-import-tool.md`

Use actual paths/IDs from prior task evidence, not guessed names. Read focused wiki pages before editing code.

## Ownership

Restricted source backup, isolated rehearsal target, and a sanitized comparison report.

## Steps

1. Revalidate Task 1 source IDs and storage mapping. Use the proven Task 23 procedure to pause source writers briefly and capture a consistent restricted immutable files/history backup.
2. Keep the source service recoverable and return it to availability after capture without automatically submitting model work. Record that later user edits require a fresh final export.
3. Import the backup into a separate rehearsal prefix/service using Task 24. Never give the rehearsal service the source's writable storage prefix.
4. Verify every file/hash and history count/branch, open representative earliest/latest histories, and send one inert explicit resume prompt under the QA limits.
5. Record expected transformations, target/source identity separation, backup locations and the exact final cutover/rollback commands. Stop rehearsal compute afterward.

## Acceptance criteria

- Source backup is checksummed and immutable, with full files/history coverage.
- Rehearsal history can be resumed and all differences are explicitly expected configuration changes.
- Source remains available and unchanged by the rehearsal target; final cutover procedure has no placeholders.

## Validation

Export/import verifier, SDK history checks, one real browser resumed turn with no tools, and source availability check.

Update affected canonical docs for behavior changes and run `npm run docs:check`. Follow the execution guide's deployment and commit rules.

## Boundary and stop conditions

No browser profile or old Goal-state import. On a failed live capture/import, preserve originals, roll back any source lifecycle change, and stop. All shared stop conditions apply. Leave this task unchecked if any required check fails or access is missing.

## Handoff

Record actual commands/results, safe evidence references, and any recovery actions under Task 29 in the root checklist. Commit before continuing to Task 30.


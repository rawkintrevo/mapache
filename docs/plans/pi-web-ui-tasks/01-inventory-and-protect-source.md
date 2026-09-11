# Task 1: Inventory the deployment and identify the HubSpot source

Difficulty: easy. Depends on no previous task. Implementation status is tracked only in [the root checklist](../../../task_list.md).

## Goal and starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then inspect:

- `docs/deployment.md`
- `docs/runtime-containers.md`
- `session-runner/lib/config.js`

Paths above are repository-relative. Upstream paths referenced below are relative to the pinned source prepared in Task 2. Read focused wiki pages before editing their owners.

## Ownership

New restricted inventory under an ignored migration directory; a sanitized handoff in the checklist.

## Steps

1. Create/reuse branch pi-web-ui-integration without resetting unrelated work. Capture current Git HEAD and existing planning changes.
2. Read current pi-agents-cloud Functions/Hosting revisions, runner image digests, workspace/session metadata, and source Cloud Run service configuration. Use read-only commands with explicit project flags.
3. Find the HubSpot workspace and its Chrome session using authenticated ownership and metadata. Record exact workspace/session/service IDs, storage prefixes, Pi session path/version, source image digest, resource allocation, and connection binding IDs in a restricted ignored inventory.
4. Verify source files/history can be read and backups can be stored outside the live prefix. Do not stop the source, deploy, copy secrets into reports, or claim a live file listing is a consistent backup.
5. Record exact cloud commands and references needed for later access and rollback, plus a sanitized compatibility assessment: can additive Functions deploys from this baseline preserve the currently running source?

If this checklist and its linked specifications are still uncommitted when
implementation starts, commit that planning package separately before the Task 1
implementation commit. Include only this plan's files, its docs navigation links,
and the archived old checklist; preserve unrelated changes. This ensures later
task commits and build revisions can recover their own execution instructions.

## Acceptance criteria

- There is exactly one evidenced source mapping and a readable recovery target; ambiguous identity or missing access stops the checklist.
- Current production state is recorded independently of the rolled-back Git baseline.
- No deployed resource or source file was modified; later tasks have exact ID/path references, not placeholders.

## Validation

Check inventory fields against live read-only metadata; run npm run docs:check for the sanitized handoff.

Update the affected canonical wiki page for behavior changes and run `npm run docs:check`. Apply the execution guide's deployment and commit rules.

## Boundary and stop conditions

Do not create a general workspace inventory application or migrate any data. The shared stop conditions apply; do not skip this task if access or an acceptance gate is blocked.

## Handoff

Add a short Completed or Blocked note under Task 1 in the root checklist. Record actual owner paths, commands/results, non-secret evidence references, and any contract refinements needed by Task 2. Check the box only after all criteria pass.

# Task 9: Keep credential mutations in Mapache

Difficulty: medium. Depends on Tasks 1–8. Implementation status is tracked only in [the root checklist](../../../task_list.md).

## Goal and starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then inspect:

- `session-runner/lib/workspaceAuth.service.js`
- `docs/pi-skills-manager.md`
- `docs/plans/pi-web-ui-tasks/decisions.md`

Paths above are repository-relative. Upstream paths referenced below are relative to the pinned source prepared in Task 2. Read focused wiki pages before editing their owners.

## Ownership

Auth materialization configuration and narrow upstream server/UI managed-policy patches.

## Steps

1. Point credential materialization to the new Pi agent directory and perform it before upstream startup.
2. Inventory upstream credential/OAuth/provider-key/secret-header mutation commands and HTTP paths. Disable them server-side in managed mode and replace UI entry points with a concise Mapache-managed explanation.
3. Keep model selection and non-secret model metadata editing usable with the materialized credentials.
4. Ensure old settings restore cannot overwrite newly materialized auth, and response/log serialization does not expose secret values. Expose an explicit secret-file inventory for the capture helper implemented later in Task 14.

## Acceptance criteria

- Existing Mapache-saved provider credentials make the model usable without entering secrets upstream.
- Forged direct upstream credential mutation requests are rejected; model choice/preferences still work.
- The materializer provides the secret-file inventory and replaces fake restored auth before launch; Task 14 consumes that inventory and tests snapshot exclusions.

## Validation

Focused materialization and upstream managed-policy tests with fake secrets, runner lint, upstream build/typecheck, npm run build if parent UI changes.

Update the affected canonical wiki page for behavior changes and run `npm run docs:check`. Apply the execution guide's deployment and commit rules.

## Boundary and stop conditions

Do not move the credential database, block owner shell access to its own environment, or build a new OAuth flow. The shared stop conditions apply; do not skip this task if access or an acceptance gate is blocked.

## Handoff

Add a short Completed or Blocked note under Task 9 in the root checklist. Record actual owner paths, commands/results, non-secret evidence references, and any contract refinements needed by Task 10. Check the box only after all criteria pass.

# Task 7: Expose gated signed agent access URLs from Functions

Difficulty: medium. Depends on Tasks 1–6. Implementation status is tracked only in [the root checklist](../../../task_list.md).

## Goal and starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then inspect:

- `functions/preview.service.js`
- `functions/sessionCreation.service.js`
- `docs/backend-api-architecture.md`

Paths above are repository-relative. Upstream paths referenced below are relative to the pinned source prepared in Task 2. Read focused wiki pages before editing their owners.

## Ownership

Existing access URL service plus focused agent-token helper and server-owned rollout marker.

## Steps

1. Add agentUrl only for a ready compatible runner in a workspace marked pi-web-ui-v1. Verify owner access using the existing requireSession path.
2. Sign the agent audience and runtime generation using the established per-session access secret/TTL; retain old access response fields.
3. Add a server-admin-only way for the deployment script to mark an explicitly identified QA workspace. Browser creation input must not set arbitrary version/image/ownership fields.
4. Deploy compatible Functions additions according to the execution guide, leaving the HubSpot source unmarked. Verify its existing access API still behaves as before.

Require an explicit reserved runtime generation in eligible new session metadata.
Task 12 supplies real reservations later; use injected fixture metadata for this
task's tests. Until then a marked session missing the generation is unavailable,
not implicitly generation zero. No hosted new runner is required to pass this task.

## Acceptance criteria

- Owner access succeeds only for eligible running sessions; cross-owner access and unsupported state fail.
- The public client cannot opt another workspace into the new runtime or choose an arbitrary image.
- Functions deploy succeeds and additive compatibility smoke passes before completion.

## Validation

Focused Functions token/ownership/response tests, Functions lint, deployment with --project pi-agents-cloud, and safe access smoke.

Update the affected canonical wiki page for behavior changes and run `npm run docs:check`. Apply the execution guide's deployment and commit rules.

## Boundary and stop conditions

No default catalog switch, source migration, or deletion of existing routes. The shared stop conditions apply; do not skip this task if access or an acceptance gate is blocked.

## Handoff

Add a short Completed or Blocked note under Task 7 in the root checklist. Record actual owner paths, commands/results, non-secret evidence references, and any contract refinements needed by Task 8. Check the box only after all criteria pass.

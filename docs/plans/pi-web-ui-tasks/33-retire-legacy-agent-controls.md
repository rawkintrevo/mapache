# Task 33: Remove the old Chat, Goals, and duplicate agent controls

Difficulty: medium. Depends on Tasks 1–32. Status lives in [the root checklist](../../../task_list.md).

## Starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then these repository-relative paths:

- `docs/workspace-goals.md`
- `docs/session-runner-architecture.md`
- `docs/frontend-architecture.md`

Use actual paths/IDs from prior task evidence, not guessed names. Read focused wiki pages before editing code.

## Ownership

Legacy Goals Functions/routes, Goals RPC/pi-goal-x helpers, old Pi Chat/PTY integration and corresponding UI/workflows.

## Steps

1. Remove Mapache Workspace Goals routes/UI/runtime and pi-goal-x install/patch/bootstrap from the supported image.
2. Remove the old transcript-tail Chat and automatic Pi TUI launch path. Preserve shell access through upstream and shared Chrome/preview/metrics support.
3. Remove duplicate model/skills/extensions/subagent/file/Git API/control code only where no retained Mapache responsibility calls it; keep credential/connection services.
4. Remove dead tests and replace touched coverage with tests of the new ownership boundaries; search imports/API manifests/generated routes for dangling references.
5. Deploy changed Functions and rebuild the candidate image; validate source migration remains usable.

## Acceptance criteria

- No supported startup path runs pi-goal-x, Goals RPC, or a second Pi TUI.
- No visible or callable obsolete Goals/Chat entry point survives; retained services still work.
- Tests/imports/routes resolve and required deployments succeed.

## Validation

Targeted rg reference audit, focused frontend/Functions/runner tests and lint, npm run build, Functions deploy and new candidate image smoke.

Update affected canonical docs for behavior changes and run `npm run docs:check`. Follow the execution guide's deployment and commit rules.

## Boundary and stop conditions

Do not remove upstream native Goals or the user's saved original migration backup. All shared stop conditions apply. Leave this task unchecked if any required check fails or access is missing.

## Handoff

Record actual commands/results, safe evidence references, and any recovery actions under Task 33 in the root checklist. Commit before continuing to Task 34.


# Task 11: Bind upstream projects and history to one workspace

Difficulty: medium. Depends on Tasks 1–10. Implementation status is tracked only in [the root checklist](../../../task_list.md).

## Goal and starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then inspect:

- `docs/plans/pi-web-ui-tasks/contracts.md`

Paths above are repository-relative. Upstream paths referenced below are relative to the pinned source prepared in Task 2. Read focused wiki pages before editing their owners.

## Ownership

Upstream workspace/project controls and session-directory configuration patches.

## Steps

1. Set /workspace as the fixed root and PI_CODING_AGENT_SESSION_DIR to the specified flat history directory.
2. Restrict project/cwd controls to /workspace and its contained paths using canonical path checks. Preserve shell behavior inside the container without claiming a shell sandbox.
3. Make all workspace histories discoverable from a new browser client/device; retain upstream client IDs only for per-client display state.
4. Reject history opens outside the configured history directory; ensure a stale client-state project cannot redirect a new session to a foreign root.

## Acceptance criteria

- Two client IDs can list/open the same saved workspace conversations without generating a turn.
- Outside-root project selection and arbitrary history path opens are rejected.
- Flat SDK session creation/list/open preserves IDs and conversation branches.

## Validation

Upstream path/history regression tests using temporary directories and symlink escapes; upstream typecheck/build.

Update the affected canonical wiki page for behavior changes and run `npm run docs:check`. Apply the execution guide's deployment and commit rules.

## Boundary and stop conditions

No multi-workspace upstream project picker or per-conversation worktree feature. The shared stop conditions apply; do not skip this task if access or an acceptance gate is blocked.

## Handoff

Add a short Completed or Blocked note under Task 11 in the root checklist. Record actual owner paths, commands/results, non-secret evidence references, and any contract refinements needed by Task 12. Check the box only after all criteria pass.


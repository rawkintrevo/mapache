# Task 4: Launch pi-web-ui as a supervised runner child

Difficulty: medium. Depends on Tasks 1–3. Implementation status is tracked only in [the root checklist](../../../task_list.md).

## Goal and starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then inspect:

- `docs/session-runner-architecture.md`
- `session-runner/lib/config.js`
- `session-runner/lib/runnerLifecycle.js`

Paths above are repository-relative. Upstream paths referenced below are relative to the pinned source prepared in Task 2. Read focused wiki pages before editing their owners.

## Ownership

New session-runner/lib/piWebUiProcess.js and its tests; small server.js/Dockerfile composition changes.

## Steps

1. Copy the pinned built artifact into pi-chrome and add configuration for the fixed loopback port and state directories. Launch after restore/materialization hooks complete.
2. Implement the start/health/stop adapter with injected spawn and clock dependencies. Generate a private per-boot upstream token without logging it.
3. Disable automatic Pi TUI and Goals RPC startup on the marked new-runtime path. Preserve the old path for unmarked source sessions during rollout.
4. Report bounded startup failure and child exit through existing runner lifecycle reporting; no endless respawn loop.

## Acceptance criteria

- Exactly one upstream child starts after prerequisites, listens only on loopback, and reports ready only after its local health check.
- Failed prerequisite/startup/child exit produces a safe visible error and no second agent process.
- pi-chrome still builds with Chrome/preview dependencies and no startup dependency download.

## Validation

Runner focused process-order/exit tests, runner lint, and local pi-chrome build plus health smoke.

Update the affected canonical wiki page for behavior changes and run `npm run docs:check`. Apply the execution guide's deployment and commit rules.

## Boundary and stop conditions

Do not add storage algorithms or cloud provisioning behavior here. The shared stop conditions apply; do not skip this task if access or an acceptance gate is blocked.

## Handoff

Add a short Completed or Blocked note under Task 4 in the root checklist. Record actual owner paths, commands/results, non-secret evidence references, and any contract refinements needed by Task 5. Check the box only after all criteria pass.


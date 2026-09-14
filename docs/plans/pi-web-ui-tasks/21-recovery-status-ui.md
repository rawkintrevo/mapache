# Task 21: Show runtime and persistence failures in the session shell

Difficulty: medium. Depends on Tasks 1–20. Status lives in [the root checklist](../../../task_list.md).

## Starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then these repository-relative paths:

- `src/components/sessions/SessionDetail.jsx`
- `src/components/sessions/useSessionAccessUrls.js`
- `docs/frontend-architecture.md`

Inspect actual owner code and predecessor handoffs before editing. Upstream paths refer to the pinned source from Task 2.

## Ownership

Focused session runtime-status hook/component and safe status endpoint if needed.

## Steps

1. Render starting/ready/stopping/stopped/error and the last successful checkpoint time for the marked runtime using server status.
2. Keep failed-save and failed-stop errors visible until acknowledged or resolved; disable unsafe restart while stop outcome is uncertain.
3. Separate browser disconnection from execution status. Reconnect/opening history never starts a model turn.
4. Handle expired access with bounded renewal, and unavailable embedding with a same authenticated agent URL opening in a new tab where supported; do not weaken auth to handle browser cookie restrictions.

## Acceptance criteria

- A failed final save cannot appear as successful Stop or auto-trigger Restart.
- Closed/reconnected browser and canvas tab changes preserve correct server execution status.
- Repeated auth/status failures back off and show actionable errors rather than an infinite busy state.

## Validation

Frontend status/selection/error regression tests, npm run build; Functions tests/deploy if an endpoint is added.

Update the affected canonical wiki page for behavior changes and run `npm run docs:check`. Follow the execution guide's deployment and commit rules.

## Boundary and stop conditions

No duplicate transcript/Goal UI or generic observability dashboard. Shared stop conditions apply; leave the root checkbox unchecked on any blocked acceptance criterion.

## Handoff

Record actual paths, commands/results, safe evidence references, and contract changes under Task 21 in the root checklist. Commit the completed task before continuing to Task 22.


# Task 20: Make Cloud Run lifetime independent of browser traffic

Difficulty: medium. Depends on Tasks 1–19. Status lives in [the root checklist](../../../task_list.md).

## Starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then these repository-relative paths:

- `functions/cloudRun.service.js`
- `functions/sessionLifecycle.service.js`
- `docs/deployment.md`

Inspect actual owner code and predecessor handoffs before editing. Upstream paths refer to the pinned source from Task 2.

## Ownership

Existing Cloud Run provisioning and lifecycle helpers for marked workspaces.

## Steps

1. Configure marked running services for min/max one instance and non-request-throttled CPU using the repository's actual Cloud Run API shape.
2. Bypass browser-idle reaping for the new runtime; explicit Stop controls lifetime. Retain current resource presets and existing service identities.
3. Implement restart/resize as bounded quiesce/final-save, confirmed service deletion, then recreation at a new generation. Never roll old/new writable revisions together.
4. On missing acknowledgement, delete uncertainty, checkpoint failure, or startup failure, report a safe error and preserve recoverable metadata instead of starting a second service.
5. Deploy the gated Functions change and retain unmarked source behavior.

Use separate, testable helper functions for template construction and lifecycle
ordering. The state machine is `running -> stopping -> stopped -> starting -> running`;
failed manual checkpoint/deletion leads to `stop_failed`, never straight to starting.
For a provably crashed/absent old service, the recovery path may start from the last
published checkpoint after generation advancement, with an interrupted warning.
Unexpected duplicate boot triggers that reconciliation; it cannot steal the old
generation. See the contracts for the manual-stop versus crash distinction.

## Acceptance criteria

- Background execution can continue without any open browser requests.
- Restart/resize ordering is verified and a failed old-service deletion cannot launch a successor.
- CPU/scaling/IAM fields match the fixed contracts and production Functions deployment succeeds.

## Validation

Focused Cloud Run/lifecycle mock tests including reaper behavior and delete timeout; Functions lint/deploy; inspect deployed template for a marked QA service later in Task 26.

Update the affected canonical wiki page for behavior changes and run `npm run docs:check`. Follow the execution guide's deployment and commit rules.

## Boundary and stop conditions

Do not globally change idle behavior for the unmarked HubSpot source or add a new billing mechanism. Shared stop conditions apply; leave the root checkbox unchecked on any blocked acceptance criterion.

## Handoff

Record actual paths, commands/results, safe evidence references, and contract changes under Task 20 in the root checklist. Commit the completed task before continuing to Task 21.

# Task 8: Embed the agent canvas and renew access without reload

Difficulty: medium. Depends on Tasks 1–7. Implementation status is tracked only in [the root checklist](../../../task_list.md).

## Goal and starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then inspect:

- `src/components/sessions/SessionDetail.jsx`
- `src/components/sessions/useSessionAccessUrls.js`
- `docs/frontend-architecture.md`

Paths above are repository-relative. Upstream paths referenced below are relative to the pinned source prepared in Task 2. Read focused wiki pages before editing their owners.

## Ownership

New PiWebUiCanvas component/hook, narrow upstream postMessage patch, and SessionDetail composition.

## Steps

1. Show the embedded canvas only when agentUrl is supplied; keep the old source-session UI unchanged.
2. Use a stable iframe per selected session, keeping it mounted across Agent/Chrome/Preview tab switches.
3. Implement typed parent/child renewal messages with origin and source checks. Rotate short-lived access, refresh the scoped cookie, and reconnect without reloading the iframe.
4. Provide loading, unavailable, and access-error states. Never resend a user's prompt as an auth/reconnect recovery action.

## Acceptance criteria

- Tab switches retain draft, scroll, and conversation selection.
- Renewal does not reload the app, submit a duplicate prompt, or accept spoofed cross-frame messages.
- Selection change discards old-session updates and never displays another workspace's canvas.

## Validation

Focused frontend renewal/selection/component tests, upstream bridge tests, npm run build; record a local browser renewal check.

Update the affected canonical wiki page for behavior changes and run `npm run docs:check`. Apply the execution guide's deployment and commit rules.

## Boundary and stop conditions

No removal of old shell controls until after migration. The shared stop conditions apply; do not skip this task if access or an acceptance gate is blocked.

## Handoff

Add a short Completed or Blocked note under Task 8 in the root checklist. Record actual owner paths, commands/results, non-secret evidence references, and any contract refinements needed by Task 9. Check the box only after all criteria pass.


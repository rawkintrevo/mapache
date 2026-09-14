# Task 6: Proxy agent WebSockets alongside existing runner sockets

Difficulty: medium. Depends on Tasks 1–5. Implementation status is tracked only in [the root checklist](../../../task_list.md).

## Goal and starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then inspect:

- `docs/session-runner-architecture.md`
- `session-runner/server.js`
- `docs/plans/pi-web-ui-tasks/contracts.md`

Paths above are repository-relative. Upstream paths referenced below are relative to the pinned source prepared in Task 2. Read focused wiki pages before editing their owners.

## Ownership

Agent gateway WebSocket module and the existing central upgrade dispatcher.

## Steps

1. Route only /agent/ws to upstream /ws using the central noServer upgrade dispatcher.
2. Check signature/cookie, exact Origin, audience, current generation, and expiry before connecting upstream. Strip external auth and inject the private upstream token.
3. Preserve protocol frames and backpressure; close paired sockets together. Enforce expiry on open connections rather than authenticating only at initial upgrade.
4. Keep Chrome VNC and metrics upgrades functioning; leave the upstream chat protocol untouched.

## Acceptance criteria

- A real upstream hello/snapshot exchange passes through the proxy.
- Rejected upgrade cannot create upstream activity; token expiry closes an already-open connection.
- Agent, Chrome, and metrics sockets coexist without an automatic upgrade listener rejecting each other.

## Validation

WebSocket route tests against a fake upstream plus a local pinned-server handshake; runner lint.

Update the affected canonical wiki page for behavior changes and run `npm run docs:check`. Apply the execution guide's deployment and commit rules.

## Boundary and stop conditions

No custom transcript streaming format, browser prompt retries, or terminal scraping. The shared stop conditions apply; do not skip this task if access or an acceptance gate is blocked.

## Handoff

Add a short Completed or Blocked note under Task 6 in the root checklist. Record actual owner paths, commands/results, non-secret evidence references, and any contract refinements needed by Task 7. Check the box only after all criteria pass.


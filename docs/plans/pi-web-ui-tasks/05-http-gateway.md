# Task 5: Add the authenticated HTTP gateway for the embedded app

Difficulty: medium. Depends on Tasks 1–4. Implementation status is tracked only in [the root checklist](../../../task_list.md).

## Goal and starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then inspect:

- `session-runner/lib/browserAccess.js`
- `docs/session-runner-architecture.md`
- `docs/plans/pi-web-ui-tasks/contracts.md`

Paths above are repository-relative. Upstream paths referenced below are relative to the pinned source prepared in Task 2. Read focused wiki pages before editing their owners.

## Ownership

New focused agent access/proxy helpers; server.js route registration.

## Steps

1. Implement /agent/ HTTP forwarding to the fixed loopback upstream, preserving the path mapping from Task 3.
2. Implement signed bootstrap verification and scoped cookie rules from contracts, stripping public credentials before forwarding and injecting the private upstream token.
3. Validate Origin for state-changing HTTP, normalize paths safely, reject off-origin redirects, and prevent raw upstream cookies from leaking.
4. Stream uploads/downloads and Range responses. Inventory actual upstream size limits and preserve bounded behavior rather than buffering arbitrary bodies.
5. Keep the health probe internal; do not expose a public authentication bypass through upstream /api/health.

## Acceptance criteria

- Unauthenticated, expired, wrong-session/audience/generation requests never reach upstream.
- Valid bootstrap loads assets and files; query credentials disappear from navigation and are not reflected in logs/Referer.
- Traversal, off-origin redirect, foreign Origin mutation, and oversized request tests fail safely.

## Validation

Runner route tests with fake upstream covering streaming/Range, headers, limits, and auth; runner lint.

Update the affected canonical wiki page for behavior changes and run `npm run docs:check`. Apply the execution guide's deployment and commit rules.

## Boundary and stop conditions

Do not add WebSocket forwarding or duplicate the upstream file API. The shared stop conditions apply; do not skip this task if access or an acceptance gate is blocked.

## Handoff

Add a short Completed or Blocked note under Task 5 in the root checklist. Record actual owner paths, commands/results, non-secret evidence references, and any contract refinements needed by Task 6. Check the box only after all criteria pass.


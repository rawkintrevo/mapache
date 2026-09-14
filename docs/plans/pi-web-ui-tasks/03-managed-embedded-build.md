# Task 3: Configure the managed app for the agent subpath

Difficulty: medium. Depends on Tasks 1–2. Implementation status is tracked only in [the root checklist](../../../task_list.md).

## Goal and starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then inspect:

- `docs/plans/pi-web-ui-tasks/contracts.md`

Paths above are repository-relative. Upstream paths referenced below are relative to the pinned source prepared in Task 2. Read focused wiki pages before editing their owners.

## Ownership

Upstream patches for web base-path helpers, web/src/main.tsx, managed settings, and server configuration.

## Steps

1. Build the app for /agent/ using upstream's existing appUrl/base-path support. Inventory all assets, HTTP endpoints, WebSocket URL, redirects, and plugin assets used by the app.
2. Disable service-worker registration for this managed embedded build. Ensure old worker cleanup is confined to this app's scope.
3. Fix Pi engine selection and managed deployment mode; reject self-update/runtime-install actions server-side and hide their UI entries. Preserve ordinary agent settings.
4. Document the complete prefix mapping used by Tasks 5 and 6, including root-relative exceptions requiring a patch.

## Acceptance criteria

- Static asset and API/WS URLs stay under /agent/ on the public origin.
- No service worker can intercept Mapache's parent app or cache stale credentials.
- Managed runtime cannot switch to DSH or self-update through direct protocol messages.

## Validation

Run upstream build/typecheck and focused managed/base-path tests; inspect built references and a local app load.

Update the affected canonical wiki page for behavior changes and run `npm run docs:check`. Apply the execution guide's deployment and commit rules.

## Boundary and stop conditions

Do not theme/rewrite upstream UI or implement the auth gateway yet. The shared stop conditions apply; do not skip this task if access or an acceptance gate is blocked.

## Handoff

Add a short Completed or Blocked note under Task 3 in the root checklist. Record actual owner paths, commands/results, non-secret evidence references, and any contract refinements needed by Task 4. Check the box only after all criteria pass.


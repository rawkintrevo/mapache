# Task 10: Connect the existing MCP adapter to the SDK runtime

Difficulty: medium. Depends on Tasks 1–9. Implementation status is tracked only in [the root checklist](../../../task_list.md).

## Goal and starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then inspect:

- `session-runner/lib/mcpConfig.service.js`
- `docs/google-workspace-connectivity.md`
- `docs/runtime-containers.md`

Paths above are repository-relative. Upstream paths referenced below are relative to the pinned source prepared in Task 2. Read focused wiki pages before editing their owners.

## Ownership

MCP bootstrap and upstream managed bridge-disable patch.

## Steps

1. Load the pinned pi-mcp-adapter exactly once through Pi SDK extension discovery, using existing Mapache .mcp.json provisioning.
2. Disable pi-web-ui's independent MCP bridge and connection editor in managed mode, including direct mutation paths.
3. Preserve configured stdio/remote transports, Google token refresh wrapper, and Chrome tool integration without copying access tokens to persisted UI config.
4. Use a deterministic MCP fixture to prove discovery/call behavior and a safe read-only live connector smoke later in hosted QA.

## Acceptance criteria

- One fixture server yields one tool set, not duplicate names/instances.
- Token refresh/materialization ownership remains Mapache and secrets do not appear in snapshots or logs.
- Unsupported adapter compatibility is reported as a blocker rather than silently replacing the connector architecture.

## Validation

Runner MCP tests, upstream managed-policy tests, deterministic SDK tool-list/call integration, and local image smoke.

Update the affected canonical wiki page for behavior changes and run `npm run docs:check`. Apply the execution guide's deployment and commit rules.

## Boundary and stop conditions

Do not perform real HubSpot writes or implement a second transport adapter. The shared stop conditions apply; do not skip this task if access or an acceptance gate is blocked.

## Handoff

Add a short Completed or Blocked note under Task 10 in the root checklist. Record actual owner paths, commands/results, non-secret evidence references, and any contract refinements needed by Task 11. Check the box only after all criteria pass.


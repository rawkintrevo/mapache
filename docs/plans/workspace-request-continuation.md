# Workspace request continuation (#511)

This page records the continuation contract implemented for issue #511. The
existing request broker remains the durable source of ticket status and result;
the embedded Pi UI owns conversation identity and turn recovery.

## Handoff

1. `workspace_request_ask` requires a stable idempotency key, submits once, and
   polls the existing caller-safe ticket for up to ten minutes. The MCP adapter
   gives this tool a 615-second request deadline.
2. Progress notifications show the target workspace, current ticket status,
   and elapsed time. The Agent turn stays active until the ticket reaches a
   terminal state or the bounded wait expires.
3. An expired wait returns the ticket ID for `workspace_request_wait`. Repeating
   the ask with the same payload and idempotency key resolves to the same ticket
   and never starts another target run.
4. At graceful runner shutdown, the Pi UI records the trusted session file for
   each streaming conversation that contains a persisted
   `workspace_request_ask` call and idempotency key. On the next attach, it
   reopens those exact conversations and injects a hidden continuation asking
   the model to retry the same call. Other interrupted turns are not resumed.
5. The existing ticket status handles success, structured failure, and
   cancellation. The source receives only the current caller-safe projection;
   target history and credentials remain private.

## Existing ownership

- `functions/workspaceRequestGrants.service.js` creates and authorizes caller
  tickets. It currently stores source workspace and session, but no trusted
  conversation or turn identity.
- `functions/automationCleanup.service.js` publishes the ticket result.
- `session-runner/automation-mcp/server.mjs` owns ask/wait polling and progress.
- `session-runner/lib/mcpConfig.service.js` sets the managed server's bounded
  request deadline.
- The pinned Pi UI source is built with patches under
  `session-runner/upstream/pi-web-ui/patches/`. Patch 0020 records interrupted
  request conversations and resumes them through existing prompt semantics.

## Verification gate

The checked-in `workspace-request-await` QA case covers the normal ask/wait
path. Release verification must also exercise source browser disconnect, source
runner restart, concurrent messages in another conversation, repeated restart,
grant revocation, cancellation races, and failed result delivery. Confirm one
target run and one visible answer in the originating chat. This milestone does
not optimize target startup latency.

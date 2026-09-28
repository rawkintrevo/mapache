# Workspace requests

This page owns the agent-to-agent request boundary. It is distinct from the owner-authenticated HTTP ticket compatibility adapter.

## Ownership and authorization

`functions/workspaceRequestGrants.service.js` stores one owner-scoped directional grant per source/target workspace pair. The owner must explicitly grant each operation: `discover`, `submit`, `read`, `reply`, and `cancel`. Grant writes require both workspaces to belong to the authenticated owner and reject self-grants. Revocation disables the grant and increments its revision; it does not delete ticket/run data.

`functions/automationAgentApi.service.js` first validates the admitted runner's owner, workspace, generation, boot, and live session. The request service then derives the source workspace from those claims and checks the target grant on every operation. Caller JSON cannot spoof source or owner identity. Target discovery returns only enabled discover grants and safe workspace names/IDs.

## Request lifecycle

Submission reuses `workspaceTickets.service.js` and `automationRuns.service.js`; it does not create a second queue or provisioning path. The target run remains a `http_ticket` shared run. Idempotency keys are namespaced by source workspace before the existing ticket key is generated. Target context and model/resource requests are validated by the existing workspace-run contract and target credentials are resolved at provisioning.

Agent reads use a caller-safe projection containing request ID, target workspace, source workspace, status, run ID, result, reply, error, and timestamps. It excludes target prompts/context, transcript, credentials, private history, and unrelated tickets. The existing owner-authenticated ticket endpoint remains the owner view and is not used as the agent broker boundary. A permitted reply creates a new queued `ticket-{ticketId}-reply-{uuid}` run linked to the prior run through `rootRunId`, updates the same ticket pointer, and uses the normal sink/admission path; it does not replay the original run.

## Image contract

`session-runner/automation-mcp/server.mjs` exposes:

- `workspace_request_targets`
- `workspace_request_submit`
- `workspace_request_get`
- `workspace_request_reply`
- `workspace_request_cancel`

The child process receives only the runner-owned Unix socket. The runner adapter refreshes the short-lived token and forwards bounded requests; it does not expose shutdown credentials to the Agent. A rebuilt `pi-chrome` image and restarted/recreated sessions are required before existing runners see these tools.

## Verification

Focused checks are `npm --prefix functions test`, runner syntax/tests, route contract tests, and `npm run docs:check`. Release verification must additionally exercise two managed workspaces, grant/revoke and negative authorization cases, paused target/caller restart, duplicate submission, cancellation races, target context/connection use, artifact projection, and tool discovery. Deploy Functions before the runner image and use the explicit `pi-agents-cloud` project and mandated service accounts.

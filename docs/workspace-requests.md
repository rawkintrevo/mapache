# Workspace requests

This page owns the agent-to-agent request boundary. It is distinct from the owner-authenticated HTTP ticket compatibility adapter.

## Ownership and authorization

`functions/workspaceRequestGrants.service.js` stores one owner-scoped directional grant per source/target workspace pair. The owner must explicitly grant each operation: `discover`, `submit`, `read`, `reply`, and `cancel`. Grant writes require both workspaces to belong to the authenticated owner and reject self-grants. Revocation disables the grant and increments its revision; it does not delete ticket/run data.

`functions/automationAgentApi.service.js` first validates the admitted runner's owner, workspace, generation, boot, and live session. The request service then derives the source workspace from those claims and checks the target grant on every operation. Caller JSON cannot spoof source or owner identity. Target discovery returns only enabled discover grants and safe workspace names/IDs.

## Request lifecycle

Submission reuses `workspaceTickets.service.js` and `automationRuns.service.js`; it does not create a second queue or provisioning path. The target run remains a `http_ticket` shared run. Idempotency keys are namespaced by source workspace before the existing ticket key is generated. Target context and model/resource requests are validated by the existing workspace-run contract and target credentials are resolved at provisioning.

Agent reads use a caller-safe projection containing request ID, target workspace, source workspace, status, run ID, result, reply, error, and timestamps. It excludes target prompts/context, transcript, credentials, private history, and unrelated tickets. The existing owner-authenticated ticket endpoint remains the owner view and is not used as the agent broker boundary. A permitted reply creates a new queued `ticket-{ticketId}-reply-{uuid}` run linked to the prior run through `rootRunId`, updates the same ticket pointer, and uses the normal sink/admission path; it does not replay the original run.

Failed/interrupted result delivery copies a bounded structured provisioning,
execution, or interruption code to the ticket's `errorCode`; raw errors and
private transcripts are never used as diagnostic fallbacks. Successful and
canceled delivery, and newly queued replies, clear earlier failure codes.
This is owned by `automationCleanup.service.js` and
`workspaceRequestGrants.service.js`.

Requests always launch separate automation runners, including when the target
main session is running. GitHub snapshot inputs use read-only automation storage
and skip repository-local Git credential configuration. Deploy Functions and
rebuild/publish `pi-chrome` for this fix; new request runners receive the new
image. Existing services retain their revision until recreated. The runner passes a bounded, per-runtime Unix control-socket path to the embedded
UI via `PI_WEB_CONTROL_PATH`; long ticket session IDs must not exceed Unix socket
path limits. Runtime data and persisted workspace identities remain unchanged. Previously
failed requests are not replayed or retroactively rewritten.

## Agent discovery and guidance

Information retrieval (for example, “get the onboarding findings from Customer
Research”) is a primary use of the existing request flow. The always-loaded
`session-runner/reference/mapache.md` routes information, conversation, and
delegation requests to the dedicated `mapache-workspace-requests` skill in
`session-runner/seeded-skills/`. `workspaceSkillCatalog.js` seeds it alongside
automation guidance for managed interactive and automation runtimes. The
scheduling skill cross-links it, but no schedule is required to ask a question.

Agents discover the existing tools on `mapache-automations`, resolve the target
with `workspace_request_targets`, submit a self-contained question, and retrieve
the answer by request ID. Guidance distinguishes missing tools, absent targets,
permission failures, and execution/configuration errors. Information requests
do not authorize added edits or publication. This is an instruction/discovery
change; tool schemas, grants, and execution behavior are unchanged.

The current image-bundled skill path remains authoritative when workspace-local
copies are older. Seeding creates missing skills without replacing user edits.
Rebuild/publish `pi-chrome` and recreate/revise existing sessions to receive the
operating reference and new skill; a repository docs edit or image tag update
alone does not refresh a running revision. No Functions deploy is needed for
this guidance-only change. Verify two live workspaces after rollout: an ordinary
information request should discover/submit/retrieve, and an ungranted target
should produce setup guidance rather than a blanket unsupported claim.

## Image tools

`session-runner/automation-mcp/server.mjs` exposes:

- `workspace_request_targets`
- `workspace_request_submit`
- `workspace_request_get`
- `workspace_request_reply`
- `workspace_request_cancel`

The child process receives only the runner-owned Unix socket. The runner adapter refreshes the short-lived token and forwards bounded requests; it does not expose shutdown credentials to the Agent. A rebuilt `pi-chrome` image and restarted/recreated sessions are required before existing runners see these tools.

## Verification

Focused checks are `npm --prefix functions test`, runner syntax/tests, route contract tests, and `npm run docs:check`. Release verification must additionally exercise two managed workspaces, grant/revoke and negative authorization cases, paused target/caller restart, duplicate submission, cancellation races, target context/connection use, artifact projection, and tool discovery. Deploy Functions before the runner image and use the explicit `pi-agents-cloud` project and mandated service accounts.

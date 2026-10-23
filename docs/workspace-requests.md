# Workspace requests

This page owns the agent-to-agent request boundary. It is distinct from the owner-authenticated HTTP ticket compatibility adapter.

The caller can use one bounded ask-and-wait tool call for ordinary information
requests. The target work remains a durable ticket, so an interrupted wait can
resume against that ticket without executing the target prompt again. See
[workspace request continuation](./plans/workspace-request-continuation.md) for
the remaining conversation-level delivery design.

## Ownership and authorization

`functions/workspaceRequestGrants.service.js` stores one owner-scoped directional grant per source/target workspace pair. The owner must explicitly grant each operation: `discover`, `submit`, `read`, `reply`, and `cancel`. Grant writes require both workspaces to belong to the authenticated owner and reject self-grants. Revocation disables the grant and increments its revision; it does not delete ticket/run data.

`functions/automationAgentApi.service.js` first validates the admitted runner's owner, workspace, generation, boot, and live session. The request service then derives the source workspace from those claims and checks the target grant on every operation. Caller JSON cannot spoof source or owner identity. Target discovery returns only enabled discover grants and safe workspace names/IDs.

## Request lifecycle

Submission reuses `workspaceTickets.service.js` and `automationRuns.service.js`; it does not create a second queue or provisioning path. The target run remains a `http_ticket` shared run. Idempotency keys are namespaced by source workspace before the existing ticket key is generated. Target context and model/resource requests are validated by the existing workspace-run contract and target credentials are resolved at provisioning.

### Model discovery and selection

`GET /api/agent/workspace-requests/models?targetWorkspaceId=...` is the
grant-gated discovery boundary. It starts or reuses the target's normal
`pi-chrome` runtime when possible and returns only safe catalog metadata:
`providerId`, `modelId`, display `name`, supported input hints, and an
`available` flag based on whether the target runtime has provider
authentication configured. The flag is evidence of configured credentials, not
proof that the provider account is entitled to every model. Stopped or
unreachable targets return `workspace_request_model_discovery_unavailable`;
the broker never invents a model from a stale catalog.

`workspace_request_ask` and `workspace_request_submit` accept either an exact
`{providerId, modelId}` pair, a friendly `name`, or a plain model-name string.
The broker resolves friendly names against the target catalog, rejects
ambiguous names, and stores only the canonical exact pair. An omitted model
uses the target runner's most recently saved normal-chat selection (read from
the restored `client-state.json` checkpoint); if that selection is stale, the
request fails with `workspace_request_model_unavailable` instead of silently
switching provider or billing route. A configured provider without usable
authentication returns `workspace_request_provider_auth_required`.

The target runner revalidates the canonical pair at dispatch, so a model
removed after discovery fails before prompt execution. The run records the
requested and resolved model identity without credentials; the target's
normal chat selection and other conversations are not mutated. The model
catalog is therefore also the repair path for existing stale selections:
discover, choose a currently available exact pair, and submit a new request
with a new idempotency key.

The request is admitted into the target workspace's normal `runtimeKind: main`
session. If that session does not exist it is created through the normal session
lifecycle; if it is stopped, the existing restart path is used. An explicit
request model wins; if omitted, the target runner inherits
the model and provider-key choice most recently saved for `/workspace`. This
selection is restored from the target's pinned UI checkpoint. Only
`ui/client-state.json` is restored; the target's interactive transcript, Pi
settings, and uploads stay private to its main runner. See
[Scheduled Automations](./automations.md#shared-workspace-run-contract) for the
shared browserless execution lifecycle.

New request and scheduled-run sessions inherit the target's saved main-session
environment entry IDs and Pi provider credential selection at session creation.
`functions/automationCredentialSelection.service.js` resolves the workspace's
canonical session (falling back to its agent-runtime session pointer), including
when that session is stopped. An explicit empty selection stays empty; legacy
`genericEnvironmentEntryIds` are supported. If no saved environment selection
exists, workspace defaults apply. Request payloads cannot replace this selection.
Only selection IDs are copied. Environment values and provider credentials are
resolved through the existing owner-private stores at provisioning/startup;
deleted entries are not resurrected from snapshots. The source must belong to
the target owner/workspace and must not be another automation. Existing run
sessions keep their pinned selections on repeated provisioning calls.

The shared-runtime route is feature-gated independently from scheduled
automation admission. Deploy the Functions change before accepting new
requests; existing target sessions need the rebuilt `pi-chrome` revision before
they can accept the runner control route.

Agent reads use a caller-safe projection containing request ID, target workspace, source workspace, status, run ID, result, reply, error, and timestamps. It excludes target prompts/context, transcript, credentials, private history, and unrelated tickets. The existing owner-authenticated ticket endpoint remains the owner view and is not used as the agent broker boundary. A permitted reply creates a new queued `ticket-{ticketId}-reply-{uuid}` run linked to the prior run through `rootRunId`, updates the same ticket pointer, and uses the normal sink/admission path; it does not replay the original run.

For successful `ticket_result` runs, `result.answer` contains the bounded text
from the target's final assistant message (up to 32 KiB), alongside the final
result, explicitly shared artifact pointers, and workspace-output location. It
does not include the conversation transcript or tool output. A successful run
status without this answer field is not evidence that the caller received the
requested information.

Failed/interrupted result delivery copies a bounded structured provisioning,
execution, or interruption code to the ticket's `errorCode`, plus a safe
`error` object with a bounded explanation and corrective `action`; raw
errors, credential-bearing URLs, and private transcripts are never used as
diagnostic fallbacks. Nested runner `state.finalError`, top-level runner
errors, model unavailability, provider-account incompatibility, and
interaction-required states are classified separately. Successful and
canceled delivery, and newly queued replies, clear earlier failure codes.
This is owned by `automationCleanup.service.js` and
`workspaceRequestGrants.service.js`.

Each request creates one fresh persisted conversation in that normal runtime,
marks it as listed, and sends the prompt to that conversation without changing
the browser's active chat. The conversation title, transcript, tool activity,
and final answer are therefore visible through the ordinary new-chat/history
UI. A request client is reused when the browser is disconnected; the first
browser attach adopts that same client so the request chat does not appear in a
second runtime. Requests remain in the normal runtime after completion and do
not delete the target session or consume an automation slot.

The runner exposes the request control contract only behind the authenticated
shutdown-token route: `GET /workspace/models`, `POST /workspace/requests`, `GET
/workspace/requests/{runId}`, and `POST /workspace/requests/{runId}/cancel`.
Dispatch claims are durable. If the control response is ambiguous after a
claim, the run is interrupted rather than blindly replayed. Cancellation is
recorded before the runner interrupt and is safe to repeat. Scheduled
automations retain their separate private-runner lifecycle and are not routed
through these endpoints. GitHub request context remains read-only, while the
normal workspace sync and credential boundaries remain authoritative.

## Resource sizing and OOM recovery

An omitted request size inherits the target workspace's configured primary-runner
CPU and memory automatically. `automationRuns.service.js` pins this resolved pair
in the queued run snapshot and request contract; explicit `resources` overrides
win. A workspace without saved resources uses the normal Small default (1 CPU,
2 GiB). No sizing question is required. Normal request sessions still use
`pi-chrome`, including the complete saved browser profile when one is available.
Concurrent requests create separate persisted conversations in the same target
runtime; they do not create sibling Cloud Run services.

`automationOomRecovery.service.js` reads only Cloud Run **platform system**
memory-limit events for the run's deterministic service since its provisioning
attempt began. Generic timeouts, exit 137, and application log messages are not
OOM evidence. The recovery workers require the existing API identity's
`roles/logging.viewer` access. A failed log lookup retains recoverable cleanup
state rather than publishing a potentially incorrect terminal result.

Only a confirmed OOM **before the durable execution claim** can automatically
retry a workspace request. Cleanup first confirms service absence, then a
transaction rechecks cancellation, workspace ownership/deletion, the ticket's
current run, and the execution claim. It queues one deterministic linked attempt
with the next supported memory size, increasing CPU only if needed for that
memory. At most two OOM retries are allowed, capped at the catalog's 8 GiB.
The original attempt and its configuration remain in history; Chrome seed and
context descriptors are preserved. The ticket points atomically at the queued
attempt, and old sink delivery cannot overwrite the newer result. Cleanup
releases the old slot through the existing admission path.

Once `executionStartedAt` (or equivalent execution state) exists, an OOM returns
`automation_execution_oom` to the caller and **never automatically replays**, even
if the run still says `provisioning` or otherwise opts into safe workflow retries.
An exhausted provisioning retry returns `automation_provisioning_oom`; the run
records whether the retry count or resource ceiling prevented escalation.
A user cancellation always takes precedence. Historical completed failures are
not retroactively replayed.

The provisioning Functions have their own memory allocation, independent of
runner resources. They do not dynamically resize themselves: deployment gives
the automation provisioning/recovery workers 1 GiB and concurrency 1. Chrome
profile verification streams the generation-pinned archive through SHA-256 and
byte-count checks instead of buffering the archive. This preserves the full
profile and validation. See [Deployment](./deployment.md) for rollout details.

## Agent discovery and guidance

Information retrieval (for example, “get the onboarding findings from Customer
Research”) is a primary use of the existing request flow. The always-loaded
`session-runner/reference/mapache.md` routes information, conversation, and
delegation requests to the dedicated `mapache-workspace-requests` skill in
`session-runner/seeded-skills/`. `workspaceSkillCatalog.js` seeds it alongside
automation guidance for managed interactive and automation runtimes. The
scheduling skill cross-links it, but no schedule is required to ask a question.

Agents discover the existing tools on `mapache-automations`, resolve the target
with `workspace_request_targets`, then call `workspace_request_models` for
that target before choosing a model. A friendly name is submitted only after
it resolves to one available canonical provider/model pair. They then use
`workspace_request_ask` with a stable idempotency key to submit a self-contained
question and wait as part of the same turn. The managed MCP server polls the
existing caller-safe request endpoint at
five-second intervals for up to ten minutes. Its MCP request deadline is longer
than that bounded wait. MCP progress notifications show the target, current
ticket status, and elapsed seconds in the Agent UI. A terminal result is returned directly; an expired wait
returns the durable ticket ID for `workspace_request_wait`. Repeating the ask
with the same payload and key reuses the ticket rather than creating target work.
If a runner restart interrupts the wait, the Pi UI records the originating
session file as part of its existing interrupted-conversation state. On the
next client attach it reopens each recorded workspace-request conversation and
injects a hidden continuation that retries the same ask and idempotency key.
Other interrupted turns retain the existing manual-resume behavior.
Guidance distinguishes missing tools, absent targets,
permission failures, and execution/configuration errors. Information requests
do not authorize added edits or publication. The grant and caller-wait contracts
remain unchanged; only target execution now uses the normal target runtime and
visible chat lifecycle.

The current image-bundled skill path remains authoritative when workspace-local
copies are older. Seeding creates missing skills without replacing user edits.
Rebuild/publish `pi-chrome` and recreate/revise existing sessions to receive the
operating reference, model discovery tool, and new skill; a repository docs edit
or image tag update alone does not refresh a running revision. Deploy Functions
before the image because the broker owns grant checks and model resolution.
Verify two live workspaces after rollout: an ordinary information request should
discover models, submit/retrieve, and report the selected model, while an
ungranted target should produce setup guidance rather than a blanket unsupported
claim.

## Image tools

`session-runner/automation-mcp/server.mjs` exposes:

- `workspace_request_targets`
- `workspace_request_models`
- `workspace_request_ask`
- `workspace_request_submit`
- `workspace_request_get`
- `workspace_request_wait`
- `workspace_request_reply`
- `workspace_request_cancel`

The child process receives only the runner-owned Unix socket. The runner adapter refreshes the short-lived token and forwards bounded requests; it does not expose shutdown credentials to the Agent. A rebuilt `pi-chrome` image and restarted/recreated sessions are required before existing runners see these tools.

## Verification

Focused checks are `npm --prefix functions test`, runner syntax/tests, route contract tests, and `npm run docs:check`. Release verification must additionally exercise two managed workspaces, grant/revoke and negative authorization cases, paused target/caller restart, duplicate submission, cancellation races, target context/connection use, artifact projection, and tool discovery. Deploy Functions before the runner image and use the explicit `pi-agents-cloud` project and mandated service accounts.

---
name: mapache-workspace-requests
description: Get information, answers, summaries, or research from another Mapache workspace, ask or talk to another workspace, delegate a task, and retrieve or follow up on its result using existing workspace-request tools.
---

# Ask another workspace

Use this skill when the user asks to get information from, ask, talk to, or
delegate work to another workspace. Information gathering is a primary use:
“Get the onboarding findings from Customer Research” needs a question and an
answer, not a schedule or a request to change anything.

## Discover before declining

1. Discover the `workspace_request_*` tools through the `mapache-automations`
   MCP server. Its name may have a collision suffix. The server name does not
   mean a schedule is required.
2. Call `workspace_request_targets` to find permitted target names and IDs.
   Resolve the requested workspace from that response. Ask a focused question
   if names are ambiguous; never invent a workspace ID.
3. Call `workspace_request_models` with the chosen target ID before submitting
   work. Match the user's model name against the returned friendly `name`,
   `providerId`, and `modelId`. If exactly one available entry matches, pass
   its exact `{providerId, modelId}` pair. If there are multiple matches, ask
   the user to choose; never invent a model ID or copy credentials. Omit the
   model only when the target's saved/default model is acceptable.
4. If tools or the target are unavailable, report the specific discovery result
   using the guidance below. Do not infer that workspace communication is
   unsupported merely because you cannot directly access another workspace.

## Request information and wait for the answer

1. Write a self-contained `request` for `workspace_request_ask`, using the
   discovered `targetWorkspaceId` and exact `targetWorkspaceName`. Include the question, relevant scope/date
   range and context supplied by the user. Use `desiredOutput` to request a
   concise answer with supporting sources where available. The target does not
   inherit this chat. For information requests, do not add edits, sends,
   publication, or other external changes. Delegated work stays within the
   user's requested scope and the target's existing authority.
2. Supply a stable `idempotencyKey` for this question and retain it in the tool
   call. `workspace_request_ask` submits once, keeps this turn active, and waits
   up to ten minutes on the same durable ticket. If the tool call is interrupted,
   call it again with the identical payload and idempotency key; this resumes
   waiting without creating duplicate target work.
3. When an expired wait returns a `ticketId`, call `workspace_request_wait` with
   that ID. Do not return control to the user merely because the request is
   queued or running. Summarize the final answer and supporting sources, clearly
   separating missing information or failed execution from an empty finding.
   Use `workspace_request_get` only for a single status inspection when the user
   explicitly asks for status.
4. Use `workspace_request_reply` with `ticketId` and `message` for clarification
   or continuation when permitted. Use `workspace_request_cancel` when the user
   asks to cancel and the grant permits it; report the returned status.

Example request: “Summarize the onboarding complaints from the last month using
Customer Research's available sources. Return the main themes and three
supporting examples with source references. This is an information request.”

## Explain the actual limitation

- **Tools missing:** This session does not expose the request tools. It may need
  the current `pi-chrome` image and a restarted/recreated runner, or runtime/MCP
  setup repair. A documentation change alone does not install tools.
- **Target absent or no targets:** Discovery lists only explicitly permitted
  workspaces. Ask the owner to check **More → Workspace request access** in the
  source workspace and grant `discover`, `submit`, and `read` for the intended
  same-owner target. Absence does not prove the workspace does not exist.
- **`request_permission_denied`:** The directional grant is missing, disabled,
  or lacks the requested operation. Follow-ups and cancellation additionally
  need `reply` and `cancel`, respectively. Agents must not self-grant access.
- **`request_target_not_found`:** The target is no longer visible to the source
  owner; report that result and recheck discovery.
- **Authentication/feature-gate or target configuration error:** Report the
  actual error. Missing target model or connections must be resolved through
  target settings; do not invent model IDs or copy credentials.
- **Queued/running or failed request:** Preserve the ID and report the returned
  status/error. Do not confuse delayed or failed execution with missing tools.

## Existing execution boundary

Both workspaces must belong to the same owner with an explicit directional
grant. A request starts a separate persisted conversation in the target's normal
runtime using available saved context and permitted connections, even when its
interactive session is paused. It does not inject a message into the active
chat or inherit unsaved live chat state.
The source receives only the caller-safe result and explicitly shared artifacts,
not target credentials, transcripts, private history, or unrelated requests.
Use the provided tools; do not bypass them with database writes or copied tokens.

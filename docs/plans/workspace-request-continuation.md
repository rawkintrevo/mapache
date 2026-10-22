# Workspace request continuation (#511)

This is an implementation plan, not a description of deployed behavior. The
existing request broker stores a source workspace and session on each ticket;
the embedded Pi UI owns conversation identity and turn state. A source session
can contain multiple conversations, so session identity alone cannot safely
select the conversation to resume when a target answers.

## Required handoff

1. At submission, capture the trusted source conversation ID and the source
   turn/request ID inside the Pi runtime. Do not accept a model-supplied
   conversation ID as authority. Persist this link with the ticket and source
   session identity. Keep the current directional grant and caller-safe result
   checks.
2. The ticket result sink records a monotonic completion event, including a
   bounded answer or structured failure. Publishing the event must be safe to
   repeat without executing the target prompt again.
3. The source runtime reconciles pending and undelivered events when it starts
   or reconnects. It addresses the recorded conversation, not whichever chat
   happens to be selected. If that conversation cannot be restored, retain a
   visible recoverable result rather than silently dropping it.
4. Delivery is claimed idempotently before resuming the source turn. Distinguish
   result delivery retry from target execution retry. Record an acknowledgement
   only after the response is durably in the source conversation. Reconcile
   unacknowledged deliveries after restart.
5. The source UI shows the target name, elapsed time, and truthful queue/run
   state while pending. The user can continue chatting or cancel. Cancellation
   and completion must converge on one displayed outcome; late completion
   cannot revive a canceled request.

## Existing ownership

- `functions/workspaceRequestGrants.service.js` creates and authorizes caller
  tickets. It currently stores source workspace and session, but no trusted
  conversation or turn identity.
- `functions/automationCleanup.service.js` publishes the ticket result.
- `session-runner/automation-mcp/server.mjs` exposes submit/get tools. A long
  poll in this MCP process is insufficient: it disappears when the process or
  runner restarts and may exceed the embedded tool-call deadline.
- The pinned Pi UI source is built with patches under
  `session-runner/upstream/pi-web-ui/patches/`. Its `ClientSession` owns
  conversations and its `AgentService` owns clients. Any continuation control
  needs to target a recorded client and conversation, then use the existing
  prompt/queue semantics without switching the browser's selected chat.

## Verification gate

Exercise requests lasting longer than ordinary tool deadlines, source browser
disconnect, source runner restart, concurrent messages in another conversation,
duplicate result notification, grant revocation, cancellation races, and failed
result delivery. Confirm exactly one visible answer in the originating chat and
no duplicate target execution. Measure queue, provisioning, execution, and
delivery separately; this milestone does not optimize startup latency.

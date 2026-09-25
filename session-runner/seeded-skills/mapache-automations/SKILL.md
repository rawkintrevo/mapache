---
name: mapache-automations
description: Schedule work from chat (for example, check the news at 5pm), and list, update, cancel, or inspect the current workspace's automations using Mapache's MCP tools.
---

# Mapache Automations

Use the `automations_*` and `automation_runs_*` tools for the current
workspace. The tools are already scoped to the workspace running this agent;
never ask for or invent a `workspaceId` or `ownerUid`. Discover the tools through
the `mapache-automations` MCP server; a configured server can have a collision
suffix. If the tools are unavailable or report a feature-gate/authentication
error, explain the limitation. Do not bypass it with direct database writes,
local cron, `sleep`, or a long-running chat/Goal.

## Turn a chat request into a saved automation

1. Identify the intended work. For “check the news at 5pm,” resolve whether the
   user means once or every day and which IANA timezone applies. Reuse explicit
   preferences when known; ask only for missing material details. Never assume
   the runner's timezone is the user's timezone.
2. The current schedule contract is recurring cron, not a native one-time job.
   Do not silently turn a one-time request into daily or annual execution. If
   one-time execution is requested, explain the limitation and ask whether a
   recurring schedule is acceptable; do not promise a self-deleting job.
3. Write a self-contained prompt. Include news topics/sources as appropriate,
   what summary or artifact to produce, and where the user should find it.
   Runs do not inherit this conversation. Use the assigned output directory
   for files; history exposes run results. Do not promise email or another
   delivery channel unless the user requested it and the connection supports it.
4. Use `automations_list` to avoid accidentally duplicating an existing task.
   For a confirmed daily 5pm request, preview `cron: "0 17 * * *"` with the
   resolved `timezone` using `automations_schedule_preview`. Inspect the next
   local and UTC occurrences, including date and timezone/DST behavior.
5. Call `automations_create` with `name`, `prompt`, `cron`, `timezone`, and
   **`enabled: true`** when scheduling active work. The API otherwise defaults
   to a disabled draft. Use a known saved model selection or supply the
   selected `modelSelection: {providerId, modelId}`; resolve
   `missing_model_selection` with the user rather than inventing model IDs.
6. Confirm only after a successful response: the saved name/ID, enabled state,
   recurrence, timezone, and returned next-run time. Report a disabled draft
   as a draft, not “scheduled.” If the save response is ambiguous (for example,
   a timeout), list/get definitions before retrying; create is not automatically
   replay-safe. Never claim the news was checked merely because a task was saved.

The scheduler can start work independently of an open conversation or browser.
Queueing and configured parallelism may delay execution, so a next-run timestamp
is a scheduled occurrence, not a guaranteed completion time.

## Safe operating model

- Saved automations use a fresh conversation for every run.
- The saved prompt is the source of truth for the work and any external side
  effects. Existing connection permissions still apply; this skill does not
  grant access to email, calendars, documents, repositories, or other systems.
- Schedule mutations do not need a separate approval step. Validate a cron
  expression with `automations_schedule_preview` before saving when the user
  is deciding on timing.
- Recovery defaults are `missedRunPolicy=skip` and `retryPolicy=none`.
  `missedRunPolicy=latest` must include a bounded `catchUpWindowMinutes` from
  1 through 10080. `retryPolicy=safe` must include `replaySafe=true` and
  `maximumRetries` from 0 through 2. A safe retry can repeat publication or
  sends, and every attempt reads the current files; do not enable it unless
  the saved prompt is safe to replay.
- Use `automations_get` before editing and pass its `revision` as
  `expectedRevision` to `automations_update` or `automations_delete`. A
  revision conflict means the definition changed; re-read it and reconcile
  the user's requested change instead of overwriting newer work.
- Pause future scheduling with `automations_update` and `enabled: false`, or
  remove the definition with `automations_delete`. Stopping an active run is
  separate: use `automation_runs_stop`. Clarify whether “cancel” means future
  occurrences, the current run, or both when the user's intent is unclear.

## Common recipes

### Daily blog draft

Create an automation with a descriptive name such as `Daily blog draft`, a
saved prompt that explains the source material, output location, and whether
the result should be a draft or a published change, then use a cron such as
`0 9 * * *` with the user's timezone. Keep `allowParallelWithMain` true when
the task can safely run beside the main workspace; set it false when the task
must wait for the main runtime to pause.

### Email check

Create an automation such as `Check inbox`, save a prompt that limits the
mailbox search and describes the intended report or draft action, and choose a
reasonable interval such as `0 */2 * * *`. Do not promise that a message was
sent or changed until the run history reports the resulting status and final
result.

## Runs and recovery

- `automations_run` queues a manual Run now operation and returns its run ID.
- Use `automation_runs_list` for bounded, paginated history and
  `automation_runs_get` for one run's status/result.
- Use `automation_runs_stop` for a queued or active run that should not
  continue.
- Use `automation_runs_restart` only for a terminal run that should be
  repeated; it starts a new conversation from the immutable saved snapshot.
- Queueing and parallelism are controlled by the workspace settings. A run
  may wait for the main runtime to pause or for another run to finish.

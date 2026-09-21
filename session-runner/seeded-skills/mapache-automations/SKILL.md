---
name: mapache-automations
description: Manage the current workspace's scheduled automations through Mapache's automation tools.
---

# Mapache Automations

Use the `automations_*` and `automation_runs_*` tools for the current
workspace. The tools are already scoped to the workspace running this agent;
never ask for or invent a `workspaceId` or `ownerUid`.

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

# Session lifecycle

Functions stores the following session states. The lifecycle helper in
`functions/sessionLifecycle.helpers.js` is the canonical owner of the vocabulary
and transition checks.

| State | Meaning | Normal next states |
| --- | --- | --- |
| `provisioning` | Firestore metadata exists and Cloud Run is being created. | `running`, `provision_failed`, `stopping`, `deleting` |
| `running` | The runner service is ready. | `restarting`, `resizing`, `stopping`, `deleting`, `update_failed` |
| `restarting` / `resizing` | An unmarked service is being changed in place; a marked pi-web-ui service is being quiesced, deleted, and recreated. | `running`, `update_failed`, `stopping` |
| `stopping` / `deleting` | Shutdown or deletion has started. | `stopped`, `stop_failed`, `delete_failed` |
| `stopped` | The service is gone and usage is finalized. | `provisioning`, `restarting`, `resizing`, `deleting` |
| `needs_image` / `needs_service` | The session cannot start until its configuration or service is repaired. | `provisioning`, `restarting`, `deleting` |
| `provision_failed` / `update_failed` / `stop_failed` / `delete_failed` | The last lifecycle operation failed and records a safe error. | Retry-specific operation, `stopping`, `deleting`, or `stopped`. |

Stored status strings remain backward compatible. A reconciliation path may pass a
`reconciliationReason` when repairing an old or externally changed document; normal
API lifecycle writes must use an allowed transition.

The five-minute idle reaper evaluates marked running sessions from the debounced
`lastActivityAt` signal and clamps eligibility to the current runner's
`runtimeStartedAt` baseline. Agent HTTP mutations, meaningful Agent WebSocket
messages, and background turn progress report activity; polling, keepalives,
reconnects, health checks, and checkpoint metadata do not. Activity writes are
fenced by the admitted runtime generation/boot authority, so a stale runner cannot
renew its replacement. Older runners fall back to `updatedAt` and `createdAt` until
recreated with an activity-reporting revision. `lastConnectedAt` and
`lastDisconnectedAt` are transport diagnostics only. Marked pi-web-ui sessions
default to `longRunning: false` and follow this policy. Users may explicitly enable
Long-running to bypass automatic pause for browser-independent agent work; the
reaper records the bypass reason and manual Pause still releases the runtime in
either state.

## Workspace runtime policy

The top-navigation runtime policy is workspace-scoped and has three exclusive
modes: **Idle timeout**, **Keep running**, and **Scheduled hours**. Existing
workspaces without a saved mode continue to use their session's existing
`longRunning` value, so adding the feature does not change their behavior.
Scheduled hours store selected ISO weekdays (Monday is 1), one same-day start
and end time, and an explicit IANA timezone. Overnight windows are rejected.

`reconcileWorkspaceRuntimeSchedules` runs every minute without a browser or
active runner. It starts a stopped main session on selected days, bypasses idle
reaping only while its window is open, and retries a failed or blocked start
until that window closes. Capacity limits and main/automation reservations still
apply. Failures are stored as safe error codes on the workspace and shown in the
policy editor. A manual Pause during an open window is remembered for that
local date, so retries do not undo the user's pause; the next selected opening
can start the session again. A manual Start clears the pause marker and uses the
ordinary idle timeout outside scheduled hours.

Enabling or editing an enabled schedule reconciles immediately. If the current
time falls outside the edited window, the normal stop lifecycle runs at once.
Disabling scheduling returns to idle-timeout behavior and does not stop a
currently running session. At a closing boundary, Functions keeps the existing
usage-accounting path but skips the runner's cooperative `/shutdown`, quiesce,
and final-checkpoint work. It requests Cloud Run service deletion
directly, so active agent turns and shell jobs are interrupted without a grace
period. After deletion is confirmed, the session is marked stopped and an
interrupted-work warning is recorded. Live process state is not preserved or
resumed after shutdown.

Schedule boundaries use local wall-clock time in the selected timezone. A
nonexistent spring-forward boundary resolves to the first valid instant after
the gap. Repeated fall-back hours remain one continuous window, using the first
matching instant for opening and the last matching instant for closing.

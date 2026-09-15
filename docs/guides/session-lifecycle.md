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

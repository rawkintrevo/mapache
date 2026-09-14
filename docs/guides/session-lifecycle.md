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

The five-minute idle reaper evaluates unmarked running sessions from `lastActivityAt`, falling
back to `updatedAt` and `createdAt` for legacy records. `lastConnectedAt` and
`lastDisconnectedAt` are transport diagnostics only: automatic Cloud Run WebSocket
reconnections must not reset the idle timeout. Marked pi-web-ui sessions bypass this
browser-idle path and are released only by explicit lifecycle actions.

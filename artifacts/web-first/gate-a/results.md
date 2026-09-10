# Gate A results — pi-chrome only

## Decision

Gate A is **not passed**. The candidate proves that a browser-side adapter can
reach the same native Pi TUI process through private local IPC and submit an
ordinary message without PTY prompt injection. It cannot prove the required
managed Goals command dispatch, browser-answerable TUI dialogs, reload, or
session replacement using Pi's public TUI extension API.

The existing headless Goals RPC path remains the legacy mode. It supports
structured dialogs, but it owns a separate Pi process and therefore does not
meet the one-process/native-terminal requirement. Gate B must not start from
this evidence.

## Experiment summary

| Task | Result | Evidence |
| --- | --- | --- |
| A01–A05 | Complete | [fixture map](fixture-map.md), [baseline](baseline.md), [environment](environment.md), [operation table](operation-table.md) |
| A06 | Pass | One real PTY Pi PID and Pi session ID stayed stable across two client attach/detach cycles. |
| A07 | Pass | Candidate image-owned `.mjs` extension uses a private Unix socket, idempotent session lifecycle cleanup, and no control JSON on terminal stdout. |
| A08 | Pass | Versioned handshake is validated; adapter disconnect rejects later requests and never writes PTY input. |
| A09 | Partial | Ordinary message admission and extension-source input were observed; no model credential was used, so complete message/tool/terminal observation is not claimed. |
| A10 | Fail | TUI `sendUserMessage` disables extension-command expansion; the candidate returns `web_first_adapter_command_expansion_unsupported`. |
| A11 | Fail | TUI native dialogs expose no supported external answer channel; the candidate returns `web_first_adapter_tui_dialog_response_unsupported`. |
| A12 | Partial | Root IDs are attached to admitted extension-originated lifecycle events; the full managed invocation/result/no-result matrix needs command dispatch. |
| A13 | Partial | `ctx.abort()` is reachable for the active root; active-tool child accounting and pending managed-dialog cancellation are not demonstrated. |
| A14 | Fail | Reload and replacement are command-context APIs, not available on the IPC-facing lifecycle context. |
| A15 | Fail | No supported browser delegation path exists for native TUI custom widgets. |
| A16 | Partial | Interactive terminal events are not attributed to the browser root; a full unrelated producer fixture remains to be reviewed with the selected adapter. |
| A17 | Pass | Runner lint and the full deterministic runner suite passed: 261 tests. |
| A18 | Pass | This report, operation table, sanitized trace, and live result are saved under this directory. |
| A19 | Pending | Maintainer review is required for the unsupported API boundary and next candidate. |
| A20 | Pass | Focused notes were added to the web-first plan and canonical runner/Goals docs; docs check is required before handoff. |

## Selected next candidate

Retain legacy RPC plus explicit interrupting terminal handoff. Ask a maintainer
to review either a pinned Pi SDK host or a minimal upstream hook that exposes
all of: command expansion from the same TUI process, external dialog routing,
command-context lifecycle controls, and stale-context fencing. Until that
review and a new real-image experiment pass, `pi-chrome` must not advertise a
web-first managed adapter.

## Cleanup

The live fixture's `cleanup()` closes the adapter socket, terminates the PTY,
escalates only inside the disposable fixture if needed, and removes its
temporary root. The captured run completed cleanup successfully; the sanitized
raw event trace is in [live-trace.jsonl](live-trace.jsonl), and identity/result
data is in [live-results.json](live-results.json).

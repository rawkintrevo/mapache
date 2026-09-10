# Gate A fixture map

The fixture uses one real interactive `pi` process in a PTY and one private
Unix socket owned by `piWebFirstAdapter.extension.mjs`.

| Concern | Owner | Evidence |
| --- | --- | --- |
| Starts native Pi | `session-runner/lib/terminal.js` → `node-pty.spawn()` → `terminalCommand()` | Existing runner path; Gate A fixture uses the same PTY shape. |
| Browser ordinary prompt candidate | `piWebFirstAdapter.extension.mjs` → public `pi.sendUserMessage()` | `input` event with `source: extension`; no PTY write. |
| Browser structured events | Pi `on("agent_*"/"message_*"/"tool_execution_*")` hooks | Sanitized `live-trace.jsonl`; model-free run only reaches input. |
| Existing Chat submit path | `piChatWebSocket.js` → `terminalSession.writePrompt()` | Legacy PTY prompt injection; not used by Gate A adapter. |
| Existing managed Goals path | `goalsRpc.service.js` → child `pi --mode rpc` | Separate headless Pi process; structured dialogs work there, but it is not the native TUI process. |
| Goal command mapping | `goalsProtocol.js` → `promptForCommand()` | Existing legacy/RPC command strings. |
| Goal confirmation compatibility | `patchPiGoalX.js` | Patches only `ctx.mode === "rpc"`; it does not make TUI custom dialogs browser-addressable. |
| Startup/shutdown | `runnerLifecycle.js` | Starts workspace/runtime services and stops Goals RPC; native terminal starts on first attach. |

The candidate adapter deliberately returns explicit unsupported errors for
extension-command expansion, TUI dialog answers, reload, and session
replacement. It never writes those requests to PTY stdin.

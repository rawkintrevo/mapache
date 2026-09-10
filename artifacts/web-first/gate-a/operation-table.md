# Gate A Pi operation table

Source inspected: the pinned Pi RPC and extension declarations used by the
prototype. The image pin is Pi `0.84.1`; the local host used for the first
fixture run reported `0.80.6`, so live package-specific conclusions must be
re-run in the rebuilt image before any gate is reconsidered.

| Operation | Supported API/source | Evidence or limitation |
| --- | --- | --- |
| Ordinary prompt | TUI `ExtensionAPI.sendUserMessage(content)` | Supported; triggers the same `AgentSession`, emits an extension-source `input` event, and returns no completion promise. |
| Extension-command dispatch | `AgentSession.prompt(text, {expandPromptTemplates: true})` in Pi core/RPC | Not exposed by the TUI `ExtensionAPI`; `sendUserMessage` explicitly calls `prompt(..., expandPromptTemplates: false)`. The candidate rejects slash commands. |
| Lifecycle/message/tool events | `ExtensionAPI.on("agent_*"/"message_*"/"tool_execution_*", handler)` | Supported; candidate forwards bounded summaries over IPC and attaches a root ID only while the admitted extension root is active. |
| Cancel | Event `ExtensionContext.abort()` | Supported for the active model operation; child processes, managed continuations, and pending native dialogs were not proven by this TUI candidate. |
| Dialog request/response | TUI `ctx.ui.select/confirm/input/editor/custom` | Native TUI UI is supported in-process, but no public request ID/response method is exposed to an external IPC client. Browser answer is unsupported. Pi RPC mode has a separate structured UI protocol. |
| Session identity | `ctx.sessionManager.getSessionId()` and `getSessionFile()` | Supported; handshake records Pi session ID and process PID. |
| Reload | `ExtensionCommandContext.reload()` | Not available on lifecycle event contexts; no supported IPC-to-command-context bridge. |
| Session replacement | `newSession`, `fork`, `switchSession` on `ExtensionCommandContext` with `withSession` | Not available on the candidate's event context; stale-context invalidation cannot be safely bridged from this extension. |
| Session export | Pi RPC `export_html`; TUI extension context has no equivalent export action | Unsupported by the candidate. Use existing offline/RPC export only. |

The table is the maintainer-review input required by A05/A19. Unsupported
requirements remain explicit; no undocumented runtime mutation or PTY fallback
was added.

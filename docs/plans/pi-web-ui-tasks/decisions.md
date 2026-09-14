# Fixed decisions

Product decisions below were agreed in the planning conversation. Engineering
defaults are selected here to make implementation executable; they are not claims
that the user separately chose every transport parameter.

## Product boundaries — settled

| Question | Binding answer |
| --- | --- |
| Runner choices | pi-chrome only; remove the selector and other supported runner families |
| Workspace concurrency | One admitted active runner per workspace; multiple upstream conversations share its files |
| Cloud platform | Retain Firebase/Cloud Run/Cloud Storage and the existing GCP project |
| Mapache responsibilities | Login, workspaces, runner resources/lifecycle, credentials, external connections, persistence |
| Upstream responsibilities | Chat, tools, shell, live files/Git, history, model selection, skills/extensions/subagents and agent preferences |
| Interface | Embedded upstream app; Persistent Chrome and Preview remain sibling surfaces |
| Goals | Use native pi-web-ui Goals; remove old Mapache Goals and pi-goal-x |
| Lifetime | Browser disconnect does not stop work; explicit workspace Stop stops execution |
| Recovery | Restore saved files/history/settings; require an explicit user prompt/resume to execute again |
| Migration | Only HubSpot workspace's Chrome session files and Pi conversation history |
| Not migrated | Browser profile/tabs/logins, old Goal state, other session histories, Codex/SSH state |
| Existing account connections | Retain workspace identity and Mapache credential/connection bindings; materialize credentials afresh |

## Engineering defaults — implement without reopening design

- Pin upstream commit `46880b3772591beac91c0c1792bdc79a6fe3671f`, package version `0.79.0`. Use a checked-in lock/patch manifest and a reproducible fetched source build under the runner build context. No Git submodule or whole upstream source vendoring; no startup downloads. Use Node 24 and retain license attribution.
- Keep upstream React in an iframe. Serve it at `/agent/` through the existing runner gateway to `127.0.0.1:8787`. Use upstream subpath helpers where available. Disable its service worker for the embedded managed build.
- Keep Pi as the only upstream engine. No DSH exposure. Keep managed update/plugin-marketplace restrictions; ordinary agent skills/extensions remain configurable through upstream's supported settings.
- Keep the existing pi-mcp-adapter path for Mapache MCP connections, including configured remote transports and Google token refresh. Disable upstream's separate MCP bridge and connection editors. Pin a compatible adapter version after source/package inspection; a broken adapter is a compatibility blocker, not permission to redesign connectors.
- Model selection and non-secret model metadata belong upstream. Credential entry, OAuth, provider keys, secret headers, and connector edits belong Mapache. Enforce this on server message/HTTP handlers, not only by hiding UI. Do not claim that an owner-controlled shell cannot read its own runtime credentials.
- Bind each runner to `/workspace`; remove upstream project switching outside that root. Paths inside `/workspace` remain usable. Workspace-bound conversation history is visible across reconnects/devices; preserve upstream client IDs as UI identities, not auth identities.
- Treat open running workspaces as explicit resources: bypass the browser-idle reaper for the new runtime and keep CPU available without requests. Users stop the workspace to release compute. Do not add a hidden inactivity shutdown or new billing product.
- Retain current resource presets and the source workspace's allocation. Resize uses the same stop/checkpoint/recreate sequence as restart; do not do a live rolling replacement.
- Reuse `/workspace` for files; put Pi config, history, and UI state under `/var/lib/mapache/agent/{pi,sessions,ui}`. Set `PI_CODING_AGENT_SESSION_DIR` explicitly to the flat `sessions` directory; preserve transcript IDs/content instead of rewriting history into another format.
- Save workspace files every 30 seconds (existing default); agent history/settings every 60 seconds and at a debounced completed-turn boundary. Serialize saves. Graceful stop requires a final acknowledged save. Forced loss restores the last completed checkpoint; cadence is a target, not a promise during storage failures.
- Persist native Goal text/preferences/last visible status for reference. Restore it paused, with no automatic review/model turn. Do not implement durable tool execution or the old Goal operation ledger.
- Use immutable checkpoint objects and a generation-checked authoritative pointer. Stale containers must not publish over a successor. Reuse existing writer coordination rather than adding an unrelated control plane.
- No automatic deletion of HubSpot backups or legacy user data in this backlog. Cleanup removes only specifically recorded QA resources and obsolete code/build paths.
- Reuse existing workspace/session IDs for HubSpot cutover; transfer its history/files into the new storage layout. No schema-wide migration. Keep blank and GitHub workspace creation; remove SSH workspace creation. Historical unsupported records may display an inactive explanation but cannot launch unsupported runners.

## Limits that are not unresolved design questions

- Cloud Run may replace containers. At most one runtime is admitted to execute
  and publish; service scaling settings alone do not establish that invariant.
- Multiple upstream conversations share one working tree. No automatic merge,
  worktree-per-conversation, or collaborative multi-user editing is included.
- A stopped/replaced process cannot resume an in-flight shell command. Saved
  conversation history and explicit new execution are the recovery contract.
- Preserved files can include old package declarations. Remove only known managed
  launch declarations that conflict with the new runtime, record the transformation,
  and keep the original backup. Never silently drop an unreadable transcript.
- Missing cloud/browser access or an ambiguous source session requires a bounded
  stop per the execution guide. No document can honestly guarantee those external
  conditions in advance.

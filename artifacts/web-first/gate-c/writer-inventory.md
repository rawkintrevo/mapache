# Gate C writer inventory

Scope: the opt-in `pi-chrome` runner only. The image remains configured with
`MAPACHE_WEB_FIRST_ENABLED=false`; this inventory is the boundary review for
the fixture/canary path, not a claim that the whole platform is fenced.

| Writer or publisher | Entry point | Destination | Stop/isolation boundary | Gate C disposition |
| --- | --- | --- | --- | --- |
| Structured Pi prompt and lifecycle events | `webFirstAgent.js` → `piWebFirstAdapter.js` → image-owned Pi TUI extension | Pi session JSONL under `PI_SESSION_DIR`; local operation ledger; checkpoint payload | Execution authority, mutation barrier, adapter disconnect, and Pi PTY process supervisor | Included for runner-owned work; the adapter still lacks command expansion, native dialog answers, reload, and session replacement (Gate A open). |
| Native terminal Pi process | `terminal.js` and `/terminal` WebSocket | Shared workspace, Pi session tree, Git worktree, local auth/config | Receiving-boundary authority/barrier checks; registered with `processSupervisor`; authority loss kills the PTY and suppresses its completion sync hook | Included for admission and termination. |
| Browser shell | `shell.js` and `/shell` WebSocket | Shared workspace and child-process side effects | Receiving-boundary authority/barrier checks; registered with `processSupervisor`; authority loss kills the shell PTY | Included for runner-owned writes. Detached children created by shell commands are not independently discoverable. |
| Git operations | `gitRoutes.js` → `git.js` | Local worktree and `.git`; GitHub remote for push/PR | `git.runMutation` wraps mutating routes with authority/barrier checks; successful independent mutations request a checkpoint | Included at the runner route boundary. Git subprocess descendants and remote-side effects remain cooperative. |
| Workspace file sync | `workspace.js` → `workspaceSyncCoordinator.js` | Normal workspace objects and archive targets under the workspace Storage prefix | Writer reservation plus authority/barrier checks; new-mode periodic sync uses checkpoint publication instead of normal worktree upload | Runner-owned sync is gated. Existing legacy runners and backend file writes can still write the canonical workspace domain. |
| Browser/file-browser save | Functions Storage write followed by protected `/workspace/sync-down` | Canonical workspace Storage objects, then local `/workspace` | Runner sync-down is gated and requests a checkpoint; the remote Functions write happens before the runner can reject an active execution | Uncontrolled external writer; C17/C18 remain open. |
| Pi package, skill, and subagent CRUD | `piPackage.service.js`, `workspaceSkill.service.js`, `workspaceSubagent.service.js` | `.pi/settings.json`, `.pi/skills`, `.pi/agents`, package caches, and normal workspace objects | Authority/barrier wrapper; successful changes request a checkpoint; package cache upload remains a separate archive target | Included at the runner route boundary. No backend publisher transaction yet. |
| Pi model/auth materialization | `piModelScope.service.js`, `workspaceAuth.service.js`, and protected agent routes | `/root/.pi/agent`, GitHub CLI hosts, and Firestore agent-auth data | Authority check for live routes; credentials/config are excluded from recovery archives | Intentionally outside the workspace recovery payload; separate audit remains. |
| Chrome profile archive | `chromeProfileSnapshot.service.js` → `workspaceArchives.service.js` | Fixed `.mapache-internal/chrome/chrome-profile.tar.gz` object | Writer reservation, authority/barrier through `syncChromeProfileUp`, and existing Chrome profile serializer | Separate browser-state archive, not part of the checkpoint pair. Direct canonical overwrite remains a Gate C audit item. |
| Preview/browser QA/export | `browserQa.js`, preview services, and `previewShare.service.js` | `$MAPACHE_QA_DIR` and public preview Storage objects | Existing browser QA/page ownership and runner access gates | Not part of workspace recovery. No claim is made that arbitrary preview processes are fenced. |
| Managed Goals RPC | `goalsRpc.service.js` / `goalsProtocol.js` | A second headless Pi process and its Pi session | Process supervisor exists, but both Goals bridges are disabled when `webFirstEnabled` is true | Explicitly excluded to prevent two Pi processes in the new mode. |
| Checkpoint payload publisher | `workspaceCheckpoint.service.js` | Immutable epoch/checkpoint objects, then paired Firestore recovery pointers | Authority transaction validates writer reservation, runtime/epoch, prior pointer, and revision; barrier closes included writers; cleanup protects the committed pair | New runner-controlled publisher implemented. The runner service identity can still bypass this cooperatively; backend enforcement is pending. |
| Legacy/default runner paths | Existing `workspace.js`, archive sync, terminal exit hooks, and non-web-first images | Same normal workspace/archive Storage domain | No new-mode authority record is consulted when the flag is false | Deliberately retained. Legacy/new-mode exclusion is not proven platform-wide. |

## Required recovery action

If authority renewal, adapter identity, barrier closure, object integrity, or
pointer publication fails, the runner fences mutation admission and reports a
recovery-required/inspection-and-stop state. It does not start a replacement
Pi process or guess at a newest object. An operator must verify the committed
checkpoint and explicitly recreate/recover the session after the predecessor
and any uncontrolled writer are understood.

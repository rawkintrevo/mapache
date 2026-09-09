# Workspace Goals for Pi: implementation plan

Status: controlled release slice complete; recovery work remains. Foundational
contracts, API, runner command surface, RPC dialog relay, image package
install/reconciliation, first workspace dashboard, Functions deployment,
Hosting deployment, and in-place Pi image rebuilds are complete. Durable
checkpointing, lease renewal, and full recovery remain before general release.
Prepared September 9, 2026; implementation started September 9, 2026.

Implementation decision for the controlled slice: pi-goal-x `0.31.2` is driven
through Pi's supported JSON RPC mode in a second headless Pi process inside the
existing runner container. The Web UI owns that process through the protected
runner bridge; terminal attachment is blocked while it is active so two Pi
processes cannot write the same session. A future in-process SDK bridge can
remove that process split, but it is not required for the current image rollout.

Audience: a junior developer implementing the feature with a senior reviewer.

This is option 3: a persistent workspace Goals dashboard powered by a prebaked
`pi-goal-x` extension, with goal creation, planning, execution controls, review,
and recovery available in the web UI. The initial controlled release is deployed
using the existing Pi image tags; the remaining sections describe the hardening
needed before general release.

## 1. What the finished feature should do

A user can open a workspace without starting a runner and see its saved goals.
They can save an idea, choose a compatible Pi session, refine the idea through
browser questions, approve a plan, and start work. The dashboard shows tasks,
evidence, current activity, requests for input, and the completion audit. Closing
the browser does not stop an already running goal. If the runner stops, the
dashboard preserves the last saved state and offers an explicit Resume action.

The user should never need a terminal command or terminal dialog to complete the
normal goal workflow. Terminal remains accessible for ordinary development.

### Initial release boundaries

| Area | Decision for this plan |
| --- | --- |
| Execution images | `pi-basic`, `pi-web`, and `pi-chrome` |
| Other images | Dashboard history remains readable; execution controls require a supported Pi image. Shell, Codex, SSH, and `pi-n64` execution are outside this release. |
| Workspace types | Blank and GitHub cloud workspaces; SSH workspaces show an explanation. |
| Concurrency | Many saved goals; at most one managed goal executing per workspace, including drafting and auditing. Different workspaces may execute independently. |
| Session assignment | Choose an existing compatible writer session, or explicitly create/restart one through the existing session workflow. |
| Recovery | Explicit user resume after process loss; no unattended creation of replacement services. |
| Completion | Preserve the extension's audit policy. An agent's completion claim is not itself an audit approval. |
| Task editing | Revise the plan through the guided flow. Do not add arbitrary drag-and-drop task mutation in the first release. |
| Notifications | In-app status and requests for input. Email, Slack, push notifications, schedules, and goal dependencies are later work. |
| Spending controls | Show available token/time usage and runner resource estimates. Do not claim an exact monetary cap. |

One executing goal per workspace is an intentional first-release limit. Supporting
concurrent goals that modify the same repository would require isolated worktrees,
separate checkpoint ownership, and a merge workflow. That is a separate project.

### User acceptance example

1. Open a blank workspace and save “Build a CSV export with tests.” No runner starts.
2. Click Start, select `pi-basic`, and use the existing auth/resource selection.
3. Answer clarification questions in Goals, inspect the proposed tasks and
   verification requirements, select auditor settings, and approve.
4. See the current task and evidence update. Close and reopen the browser.
5. Pause, revise a requirement, approve the revision, and resume.
6. Stop the session; see an interrupted or paused goal with its checkpoint time.
7. Resume on a compatible session and continue from saved state.
8. Inspect audit feedback or the completed result without opening Terminal.

## 2. Read these before coding

Start with [the wiki index](../README.md) and
[the reading protocol](../llm-reading-protocol.md). Then read:

| Topic | Local source | Why it matters |
| --- | --- | --- |
| Images and persistence | [Runtime containers](../runtime-containers.md), [runner architecture](../session-runner-architecture.md) | Startup ordering, home restore, PTY, archives, access tokens |
| Package installation | [Pi extension manager](../pi-extension-manager.md) | Existing package scope, cache and settings handling |
| Session ownership | [Backend API](../backend-api-architecture.md), [session lifecycle](../guides/session-lifecycle.md) | Authentication, provisioning, writer reservations, stop/restart |
| Feature gating | [Runner harnesses](../runner-harnesses.md) | Shared catalog and mixed image revisions |
| React integration | [Frontend architecture](../frontend-architecture.md), [UI components](../ui-components.md), [style guide](../STYLE_GUIDE.md) | Workspace navigation and component ownership |
| Validation and release | [Testing](../testing.md), [deployment](../deployment.md), [wiki updates](../wiki-update-protocol.md) | Required checks and rollout conventions |

Verify documentation against these existing implementation owners:

- Images: `session-runner/Dockerfile.pi-basic`, `.pi-web`, `.pi-chrome` and their
  `cloudbuild.*.yaml` files.
- Catalog: `functions/runnerCatalog.json`, `scripts/generate-runner-catalog.mjs`,
  `session-runner/lib/harnesses/metadata.js`.
- Runtime: `session-runner/server.js`, `lib/terminal.js`, `lib/harnesses/index.js`,
  `lib/piChatWebSocket.js`, `lib/piChat.service.js`, `lib/activity.js`.
- Sync: `session-runner/lib/workspaceSyncCoordinator.js`,
  `workspaceArchives.service.js`, `workspacePath.helpers.js`,
  `workspaceGithub.service.js`, `workspaceSyncGeneration.helpers.js`.
- Backend: `functions/sessionCreation.service.js`, `sessionLifecycle.service.js`,
  `syncWriterLease.service.js`, `syncWriterLease.helpers.js`, `cloudRun.service.js`.
- Routing: `functions/apiRouteManifest.js`, `apiHandlers.helpers.js`,
  `apiDispatch.helpers.js`, and runner `routes/`.
- Frontend: `src/components/workspaces/WorkspacePanel.jsx`,
  `src/components/sessions/SessionDetail.jsx`, `src/services/api.js`,
  `src/controllers/`, and `src/workflows/`.
- Access policies: `firestore.rules`, `storage.rules`, `firestore.indexes.json`.

### Facts established during planning

Mapache's three target Dockerfiles already install `pi-mcp-adapter`. Their Pi
installation currently uses the hosted installer rather than an explicit version
pin. Workspace home restore can replace files created during the image build.

Chat sends text to the existing PTY and reads completed conversation messages.
It is not a structured extension-control transport. The PTY is created lazily
when terminal input or attachment needs it. Goals must be able to start that same
process without a browser attaching first.

The workspace sync coordinator captures a writer role at construction. Changing
Firestore ownership alone is insufficient evidence that an already running
reader has become an uploading writer. Test and implement that transition before
allowing goal handoff. The idle reaper uses activity timestamps; browser presence
is not the execution-liveness contract.

Upstream separates goal records from session-local focus and durable draft
entries, and centralizes mutation in `GoalService`. Recovery must preserve both
project and session state. These observations come from the
[upstream architecture](https://github.com/tmonk/pi-goal-x/blob/main/docs/architecture.md).
Use that mutation boundary instead of writing active goal files independently.

The entrypoint exposes `_goalCore` explicitly as a test/debug hook, not a public
integration contract. Do not ship a bridge that depends on it. See
[the entrypoint](https://github.com/tmonk/pi-goal-x/blob/main/extensions/goal.ts).
The [questionnaire implementation](https://github.com/tmonk/pi-goal-x/blob/main/extensions/goal-questionnaire.ts)
also documents custom-UI unavailability in non-terminal hosts. Simply switching
to a headless transport does not establish that planning dialogs work.

The [package listing](https://pi.dev/packages/pi-goal-x?name=goal) reported 0.30.5,
while [main's manifest](https://github.com/tmonk/pi-goal-x/blob/main/package.json)
reported 0.31.2 with Pi peer dependencies in the range `>=0.83.0 <0.85.0` when
inspected. These are moving references, not a selected release. Record immutable
versions and source commits during the prototype.

## 3. Architecture to implement

```text
Workspace Goals UI
   | Firebase-authenticated commands
   v
Cloud Functions: ownership, durable operations, execution reservation
   | protected runner request
   v
Runner Goals service
   | versioned local RPC
   v
Headless Pi RPC process inside the existing runner container
   | supported adapter calls and structured UI requests
   v
pi-goal-x: goal behavior, tasks, verification, audit

Runner --> immutable Cloud Storage checkpoints
Runner --> validated backend updates --> Firestore summaries / operations
Browser <-- owner-readable Firestore subscriptions
```

Use Firestore subscriptions for the dashboard in the first release. Do not add
another browser WebSocket solely for goal state. A short, durable question/answer
round trip through Functions is sufficient. Throttle routine progress updates;
do not write each token to Firestore.

### Responsibilities and data ownership

| Owner | Owns | Must not do |
| --- | --- | --- |
| `pi-goal-x` | Semantic goal state, tasks, evidence, audit decisions | Become a second independent engine inside a dashboard service |
| Goals RPC bridge | Typed commands, UI requests, normalized snapshots, session focus | Scrape ANSI output or execute arbitrary browser-supplied code |
| Runner service | RPC process readiness, checkpoints, command delivery, terminal exclusion | Start an untracked second Pi process or allow overlapping session writers |
| Functions | Auth, assignment, reservations, operation recovery, validated projections | Pretend a queued command has already succeeded |
| Firestore | Saved UI drafts, assignment, run lifecycle, operations, readable projections | Independently mutate an imported engine task tree |
| Cloud Storage | Immutable recovery artifacts and checkpoint manifests | Treat a partially uploaded checkpoint as restorable |
| React | Forms, questions, readable progress and errors | Hold the only copy of a goal or pending operation |

There are two explicit creation stages: a Mapache idea/draft can exist without a
runner; after import, the extension owns semantic changes. Keep a stable Mapache
`goalId` and an optional `engineGoalId` mapping. Never create a second engine goal
because a browser retried a request.

## 4. Required prototype before feature work

Timebox the initial investigation to 2–4 developer days, then review the result.
This estimate is a planning allowance, not evidence that the bridge is easy.

Build the prototype in an isolated branch/container. Do not deploy it to production.

1. Select a published extension release and a compatible Pi version. Record their
   versions, immutable source commits, artifact integrity, license, and Node version.
2. Inventory every relevant entrypoint: create/direct-create, focus, pause,
   resume, tweak, archive, settings, task confirmation, question/questionnaire,
   proposal confirmation, completion audit, and recovery inspection.
3. Determine whether a supported in-process adapter hook exists in the selected
   release. If it does not, prepare a minimal fork that adds injected command,
   snapshot, UI-request, and lifecycle hooks. Route those hooks through existing
   extension behavior; do not copy the goal engine into Mapache.
4. Prove a local socket can reach the SAME Pi process used by Terminal and Chat.
   Prefer a Unix domain socket under a session-local `/tmp` directory, with strict
   message schemas and bounded payloads. Keep it outside synced workspace paths.
5. Execute direct creation, guided creation, one question, one proposal approval,
   pause during work, resume, settings change, and archive cancellation.
6. Demonstrate that every goal-related terminal dialog has a structured equivalent,
   including task-plan replacement and audit-related confirmations.
7. Kill and restart Pi. Identify exactly which files/entries restore the goal,
   focused session, accepted plan, and draft. Reissue pending UI requests with new
   request IDs; do not assume an in-memory Promise survives a restart.
8. Demonstrate process startup and progress with no Terminal or Chat browser open.
9. Verify terminal-originated goal changes reach the same bridge and ownership
   guards. A second loaded copy of the extension must be detected.

Deliverables: a compatibility matrix, protocol sketch, replay fixtures, recorded
pass/fail evidence, and an integration decision written into this plan or a focused
ADR. A senior reviewer must inspect the mutation boundary and UI adapter before
the junior developer proceeds to production bridge code.

**Exit gate:** all normal goal controls and questions work without terminal input.
If a supported hook cannot do this, choose and pin the minimal fork. Do not quietly
reduce the feature to slash-command buttons. A wholesale RPC/SDK conversion of
Mapache's terminal architecture requires a separate design review if the preferred
in-process adapter proves infeasible.

## 5. Persistence model

Proposed Firestore paths, all under an existing owned workspace:

```text
workspaces/{workspaceId}/goals/{goalId}
workspaces/{workspaceId}/goals/{goalId}/runs/{runId}
workspaces/{workspaceId}/goals/{goalId}/tasks/{taskId}
workspaces/{workspaceId}/goals/{goalId}/events/{eventId}
workspaces/{workspaceId}/goals/{goalId}/questions/{questionId}
workspaces/{workspaceId}/goalOperations/{operationId}
workspaces/{workspaceId}/goalControl/execution
```

Keep control state in a server-written document. Current workspace rules allow
owners to update workspace documents; putting authoritative execution fields on
that document without restricting writes would make them client-editable.

Suggested goal document:

```js
{
  schemaVersion: 1,
  ownerUid, workspaceId, goalId,
  title, objective, mode: "regular", // or "sisyphus"
  engineGoalId: null,
  lifecycle: "draft",
  activeRunId: null,
  assignedSessionId: null,
  revision: 0,
  taskCounts: {total: 0, completed: 0, skipped: 0},
  currentTaskId: null,
  audit: {enabled: true, status: "not_started"},
  usage: {inputTokens: null, outputTokens: null, elapsedMs: 0},
  checkpoint: null, // validated manifest reference + timestamp + revision
  lastObservedAt: null,
  createdAt, updatedAt
}
```

Treat these fields as a proposed normalized view, not an upstream record format.
Missing usage means unknown, not zero. Separate attempted completion, verified
completion, and completion with auditing disabled. Archive is not synonymous with
successful completion.

Each run records session ID, process instance ID, lease epoch, start/end times,
outcome, last heartbeat, checkpoint reference, and revision. A goal can have many
runs. Keep model settings used by a run so changing workspace defaults does not
rewrite historical audit metadata.

Operation documents include `operationId`, `action`, validated payload,
payload hash, expected goal revision, run/epoch, status, safe error, and timestamps.
Use `queued`, `delivering`, `applied`, `failed`, `cancelled`, and `uncertain` states.
The browser supplies an idempotency ID; Functions scopes it to the workspace and
returns the original result for a retry with the same payload. Reuse with a
different payload is a conflict.

Questions include kind, full prompt, choices, custom-answer support, draft/goal
revision, request ID, run ID, process instance, and pending/answered/cancelled
status. The first valid answer wins transactionally. An answer from an old tab
cannot confirm a different proposal.

Use paginated task/event collections rather than an unbounded array on the goal
document. Begin with 50 goals per page, 100 tasks/events per page, and documented
size limits below Firestore's document limit. Match objective and task limits to
the selected upstream release. Keep large raw evidence in private Storage with
bounded excerpts and authenticated retrieval. No raw model transcripts in list
documents. Avoid indexing long text where it is not queried.

## 6. Lifecycle, assignment, and recovery

Keep goal semantics separate from execution status. Suggested goal lifecycle:
`draft`, `ready`, `open`, `completed`, `archived`. Suggested run state:

| State | Meaning | User actions |
| --- | --- | --- |
| `preparing` | Reserving session, restoring checkpoint, starting Pi | Cancel startup |
| `drafting` | Agent refining the idea | Answer, revise, cancel |
| `running` | Agent executing the approved goal | Pause, request revision |
| `waiting_for_input` | A specific unanswered request exists | Answer, cancel request, pause |
| `pausing` | Stop requested, quiescence/checkpoint not yet confirmed | Wait; session stop remains available |
| `paused` | No continuation running | Resume, revise, archive |
| `blocked` | Engine reports a blocker | Inspect, provide input, resume |
| `auditing` | Completion review executing | Inspect, pause/cancel audit through supported semantics |
| `interrupted` | Process/service stopped unexpectedly | Inspect checkpoint and resume explicitly |
| `completed` | Engine committed completion | View result |
| `failed` | Infrastructure/adapter failure | Inspect safe error, retry where supported |

Audit rejection returns to the extension's actual open/paused/running behavior;
the adapter must not manufacture a successful completion. Record archive reason
separately from completion outcome. Specify invalid transitions in pure helper
tests before wiring API handlers.

### Starting a goal

1. Validate ownership, goal revision, supported live capability, selected credentials,
   and session state. Never take credentials from the goal payload.
2. Transactionally reserve the workspace execution slot and operation ID.
3. Require that the execution session owns workspace uploads. If another session
   is writer, return a conflict naming that session and offer use-current-writer
   or explicit handoff. Never silently stop somebody's active session.
4. Create/restart through the existing lifecycle service if requested. Store the
   pending operation so a retry cannot create a duplicate runner.
5. Restore the accepted checkpoint, reconcile engine mappings, and start the
   existing PTY once. Wait for the bridge handshake, not just HTTP readiness.
6. Deliver the typed command. Mark applied only after authoritative adapter
   acknowledgement and durable checkpoint metadata are recorded.
7. Subscribe to durable summaries. A closed browser has no role in continuation.

### Lease and stale-process rules

A lease is a time-limited right to execute. An epoch is a monotonically increasing
number identifying the current owner; messages from old epochs are rejected.

Use a transaction to reserve `{goalId, runId, sessionId, processInstanceId, epoch,
expiresAt}`. As initial tunable values, renew every 15 seconds and expire after
60 seconds. Validate using server time. A run that cannot renew must stop scheduling
new turns and checkpoint/pause where possible.

The lease must be checked by agent-tool mutations and terminal commands as well
as web commands. Enforce guards before continuation, audit start, and state mutation.
On startup do not let restored auto-continue state run before ownership is verified.
The auditor's internal child process is part of the same run, not another goal owner.

Expiry alone is not proof the old process stopped. Before assignment to another
runner, quiesce the previous process/service or confirm it has terminated. A frozen
process may later wake up. Reject its snapshots and checkpoint pointers by epoch.
Do not promise exactly-once shell commands or external effects; a crash can occur
after an effect but before its record is saved. Recovery must surface that ambiguity.

### Writer handoff

Pause and checkpoint the source; verify its shutdown or quiescence; transfer the
workspace writer reservation transactionally; restart/recreate the target with
the correct writer environment; restore and verify the checkpoint; then resume.
Do not promote a live reader merely by changing a Firestore field. Protect existing
writer release/reconciliation from assigning the slot elsewhere mid-handoff.

Reservations are released on cancel, failed provisioning, stop, delete, and
completed handoff. The reconciler repairs abandoned preparations. Stop/delete of
the execution session must also settle its goal run; deleting a session preserves
workspace goal history. Deleting the workspace follows existing ownership flow
and removes goal subcollections/checkpoints through explicit cleanup.

## 7. Durable checkpoints and failure semantics

Use a new checkpoint service, not browser file-editor writes to `.pi/goals`.
Inventory the exact selected package's goal, ledger, settings, draft, and session
files in the prototype. Snapshot under the engine mutation lock or an equivalent
consistent snapshot hook.

Proposed internal storage layout:

```text
{workspace.storagePrefix}/.mapache-internal/goals/checkpoints/{runId}/{checkpointId}/...
```

Each checkpoint has a versioned manifest with workspace/run/epoch, engine and Pi
versions, revision, artifact checksums, storage object generations, and timestamps.
Include active/archived records, required session/draft state, and enough mapping
metadata to resume. Exclude credentials and socket files. Reference the relevant
workspace code sync/Git commit information so recovery knows whether goal progress
and code correspond.

Write immutable artifacts first, manifest last, then transactionally publish the
manifest pointer if the lease epoch is still current. An upload without a committed
pointer is an orphan eligible for later cleanup. A Firestore projection must not
advance to “durably saved” before this sequence finishes.

Checkpoint after semantic transitions and at turn/task boundaries, with a bounded
periodic backup while active. Start with a 30-second periodic target and measure
overhead. Display `lastSavedAt`; runtime interruption can lose work since that point.
Goal checkpointing does not magically make all workspace files or external effects
atomic. Graceful handoff requires a successful coordinated workspace sync too.

Make generic workspace/home sync and the dedicated restore agree on ownership.
Restore general workspace/home data first, then the accepted goal checkpoint before
Pi starts. Prevent generic file saves/sync-down from overwriting live managed goal
state, and do not let stale generic goal files override the accepted manifest.
Terminal-originated edits are reconciled through the engine and checkpointed.
Do not globally exclude unrelated `.pi` files or change user repositories blindly.

### Failure behavior to implement

| Failure | Required behavior |
| --- | --- |
| Browser reload or API timeout | Recover the operation by ID; do not create/start twice. |
| Pi crashes before command receipt | Redeliver only after checking durable receipt/state. |
| Pi crashes after mutation but before acknowledgement | Inspect persisted operation marker and engine state. If not provable, mark uncertain and reconcile; never blindly replay a non-idempotent mutation. |
| Snapshot upload fails | Retain last good checkpoint; show save failure and retry with bounded backoff. Pause continuation after sustained durability failure. |
| Partial/corrupt checkpoint | Reject it, retain files for diagnosis, and offer the previous verified checkpoint with its age. |
| Browser answers an old question | Return conflict and reload the current request. |
| Lease lost or stale events arrive | Reject stale writes; stop scheduling work; reconcile ownership. |
| Runner stopped or reaped | Mark interrupted; preserve history; show explicit Resume. |
| Unsupported engine schema/version | Block execution with actionable compatibility error; do not guess a migration. |
| Audit interrupted | Record interrupted audit and rerun review after explicit resume, never infer approval. |

Initially retain the latest several verified checkpoints plus run-end checkpoints;
set an explicit retention policy before release and test garbage collection never
deletes a referenced manifest. Keep archival history distinct from temporary backups.

## 8. Command and bridge contracts

New authenticated routes under `/api/workspaces/{workspaceId}`:

| Method/path | Purpose |
| --- | --- |
| `GET /goals` | Paginated list / non-subscription fallback |
| `POST /goals` | Save a draft without a runner |
| `GET /goals/{goalId}` | Full bounded goal summary |
| `PATCH /goals/{goalId}` | Edit pre-import draft with expected revision |
| `POST /goals/{goalId}/actions` | Typed start, pause, resume, revise, focus, unfocus, archive, settings, cancel-draft, or handoff action |
| `POST /goals/{goalId}/questions/{questionId}/answer` | Answer a versioned request |
| `GET /goal-operations/{operationId}` | Recover command outcome |
| `GET /goals/{goalId}/events` | Paginated activity |
| `GET /goals/{goalId}/evidence/{evidenceId}` | Authorized retrieval of bounded evidence |

After import, title/objective/plan changes go through a typed revision action and
engine confirmation, not a direct Firestore patch. Settings must support the
selected release's task tracking, contracts, depth, focus selection and auditor
fields, with explicit default-versus-workspace scope. Use the existing model/auth
catalog rather than unrestricted provider credentials in forms.

Action example:

```json
{
  "operationId": "client-generated-id",
  "action": "resume",
  "expectedRevision": 12,
  "sessionId": "selected-session-id"
}
```

Return `202` with an operation ID for accepted asynchronous work. Acceptance is
not completion. Return stable errors such as `goal_revision_conflict`,
`goal_execution_busy`, `goal_writer_conflict`, `goal_runner_unsupported`,
`goal_bridge_unavailable`, `goal_question_stale`, and `goal_checkpoint_failed`.
Document retryability and the applicable 400/403/404/409/503 mapping.

Runner routes: protected `GET /goals/capabilities`, `GET /goals/snapshot`,
`POST /goals/commands`, and `GET /goals/operations/{operationId}`. Reuse the
backend runner-token gate. Runner-to-Functions event ingestion must have its own
explicit service/session authentication and ownership checks; a user-supplied
workspace ID or Firestore Security Rules do not authenticate Admin SDK writes.

Local IPC envelopes should include:

```js
{
  protocolVersion: 1,
  type: "command", // or handshake, snapshot, event, ui_request, acknowledgement
  operationId, workspaceId, goalId, runId,
  processInstanceId, epoch, expectedRevision,
  action, payload
}
```

The handshake reports actual Pi/extension/bridge versions and supported commands,
dialog kinds, and checkpoint schema. The UI requires BOTH catalog support and a
compatible live handshake. An old image returns a clear restart/update message.

Serialize commands per process. Persist deduplication markers with recoverable
state; an in-memory Set is insufficient. Event IDs combine run identity and a
monotonic sequence. Ignore duplicates, reject old epochs/revisions, and request
a fresh snapshot when sequence gaps appear. Never infer state from a status string
printed in Terminal.

## 9. Browser design

Add a workspace-level Goals view accessible when no session is selected. Keep a
small current-goal summary in `SessionDetail` linking to that view.

Controlled-slice adjustment: the shipped UI also renders the Goals panel from a
Goal button directly below the selected Pi session's Terminal or Chat canvas.
That entry point preselects the current session, so a user does not need to
discover or navigate to the workspace overview before creating or running a
goal. The workspace-level view remains available as a secondary entry point;
the richer screens below remain follow-up work.

### Screens/components to build

| Proposed component | Contents |
| --- | --- |
| `WorkspaceGoals.jsx` | Workspace navigation, filters, paginated cards, New goal |
| `GoalDetail.jsx` | Objective, run status, session, save freshness, controls |
| `GoalDraftForm.jsx` | Idea, regular/ordered mode, verification expectations, Save / Plan and start |
| `GoalSessionPicker.jsx` | Compatible sessions, writer explanation, existing create/restart flow |
| `GoalQuestionPanel.jsx` | Full questions, choices, custom answer, cancel, submitting/conflict states |
| `GoalProposalPanel.jsx` | Full objective/task plan/contracts, auditor choice, Confirm / Continue refining / Cancel |
| `GoalTaskTree.jsx` | Task hierarchy, current task, completed/skipped labels, evidence |
| `GoalAuditPanel.jsx` | Review progress, findings, outcome, settings used |
| `GoalActivityFeed.jsx` | Paginated semantic activity and links to run history |
| `GoalSettingsPanel.jsx` | Validated behavior/auditor defaults and workspace overrides |

Place these under **new** `src/components/goals/`, with component CSS sidecars.
Use **new** `src/hooks/useWorkspaceGoals.js` (or the closest established hooks
location) and a focused workflow/controller for subscriptions and operations.
Keep only shell wiring in `src/main.js` and `src/App.jsx`.

Required states: empty workspace, saved draft without runner, preparing, stale
snapshot, active, waiting for input, pausing, paused, blocked, interrupted,
completed, archived, incompatible image, missing auth, save failure, and operation
conflict. Use server acknowledgements for destructive/status transitions; show
“Pausing…” until the process actually stops scheduling work.

Keyboard navigation, labelled fields, visible focus, non-color status indicators,
and narrow-screen task rendering are acceptance requirements. Long objectives,
questions and evidence must remain accessible rather than silently truncated.
Render Markdown using existing safe conventions; never render raw HTML from an
agent. Changing workspaces must unsubscribe and clear old pending answers.

## 10. Implementation sequence: small PRs

Do these in order. Every PR includes focused tests and its relevant documentation
update. Keep feature flags off until the final end-to-end release gate.

| PR | Tasks and proposed owners | Acceptance gate |
| --- | --- | --- |
| 0: Integration prototype | Complete section 4 and choose adapter/fork and version pins. | Reviewer approves evidence for every dialog/control and restart behavior. |
| 1: Contracts and fixtures | **New** `functions/goals.helpers.js`, runner `lib/goalsProtocol.js`; define normalized schemas, state transitions, errors, payload limits, fixture snapshots. | Invalid transitions, stale revision, oversize payload, and unsupported versions are rejected in deterministic tests. |
| 2: Image packaging | Target Pi Dockerfiles and startup helper; install pinned engine/bridge outside restored home, load exactly once after restore; add live capability handshake. | Fresh and old-home-restored containers load the intended versions without downloading at startup; MCP adapter still works. |
| 3: Managed RPC bridge | **New** runner `lib/goalsRpc.service.js` plus `goalsProtocol.js`; typed controls, dialog relay, snapshots, process readiness, and terminal exclusion. | Structured guided flow works from the Web UI with no browser terminal attached; process ownership is explicit. |
| 4: Checkpoints | **New** `lib/goalsCheckpoint.service.js`; snapshot manifest, upload/restore, receipts, corruption handling; integrate with workspace sync. | Kill/restart and interrupted-upload fixtures restore only complete compatible checkpoints; no credential artifacts. |
| 5: Backend drafts and reads | **New** `functions/goals.service.js`; route registry, read models, rules/indexes, private evidence retrieval, draft validation. | Owner can save/list without runner; other users cannot read or mutate; no clients can write authoritative fields. |
| 6: Reservations and commands | **New** `functions/goalRuns.service.js`, `goalOperations.service.js`; transactions, durable dispatch worker, authenticated runner updates, retries. | Concurrent starts yield one owner; duplicate operations apply once or reconcile explicitly; stale runner events are rejected. |
| 7: Session recovery | Existing lifecycle/sync lease owners plus focused goal reconciler; pause/stop/resize/delete, writer handoff, unattended liveness. | Browser-free execution works; handoff has no overlapping owners; reader promotion actually enables safe sync; failed starts release reservations. |
| 8: Dashboard and direct flow | New Goals components/hook; workspace navigation, list/detail, session picker, Start/Pause/Resume/history. | Works with real APIs and reload recovery; stopped workspace still shows last saved goals. |
| 9: Guided flow and audits | Question/proposal/settings/task/audit panels and engine action mapping. | Entire normal goal workflow is web-driven, including rejected audit and plan revision. |
| 10: Fault testing and rollout | QA cases, lifecycle fault scenarios, docs, compatibility checks, canary images, release/rollback. | Section 12 passes; controlled rollout completed and recorded when implementation is authorized. |

For each PR, the junior developer should: read the listed owners, write the
observable acceptance case, implement the smallest slice, run focused checks,
update the owning doc, and request review with failure evidence. Do not open a
single PR containing the whole dashboard, distributed lifecycle, and fork.

Senior review is especially important at PRs 0, 4, 6, and 7. These involve upstream
internals, cross-service durability, or concurrency; they should not be assigned
as unsupervised UI work.

## 11. Image installation details

Use the existing Pi package installation mechanism, but make the managed package
and bridge available from an immutable image-owned location, such as
`/opt/mapache/pi-packages/`, if supported by the selected Pi loader. Prove the
actual loading method in PR 0 rather than assuming a new environment variable.

After workspace/home restoration, reconcile the managed extension declaration
without replacing unrelated settings, auth, scoped models, MCP packages, or
user-installed extensions. Detect conflicting workspace-local versions and return
an actionable incompatibility state. Never load two versions of the same goal
extension. Label the managed extension in the Extensions UI so remove/update
actions do not misleadingly claim to alter the immutable installation.

Add a `goals` capability for the three supported catalog entries, regenerate
runner catalog output with `npm run generate:runner-catalog`, and test parity.
Retain runtime handshake checks: a catalog flag cannot prove an old running
revision contains the package. Default and Codex regression tests should verify
shared runner wiring remains safe without the bridge installed. Skip N64 builds
and QA unless that scope is separately added.

## 12. Validation matrix and release gate

Use fake clocks, filesystem/storage dependencies, and an adapter test double for
deterministic tests. Real model output should not be the only pass/fail assertion.
Use isolated QA workspaces for live model/audit checks.

| Layer | Required cases |
| --- | --- |
| Protocol | Invalid action, path traversal, unexpected field, oversized evidence, version mismatch, duplicate sequence, sequence gap |
| API/auth | Unauthenticated request; another user's workspace/session; forged runner update; client writes to control/run/task docs; same idempotency ID with different payload |
| Lifecycle | Double Start; Start versus Stop; Pause during audit/tool work; two answers; stale proposal; resume after completion; archive cancellation |
| Persistence | Lost acknowledgement; crash around each checkpoint commit step; corrupt manifest; old epoch upload; home restore conflict; no credentials in checkpoint |
| Sessions | No browser attached; browser closes; process crash; Cloud Run restart; explicit stop; resize; delete; reaper; failed provisioning; reader-to-writer handoff |
| UI | Empty/loading/stale/error; long nested tasks; keyboard/mobile; reload during operation/question; switch workspace; missing auth; unsupported image |
| Engine | Direct/guided regular goal; ordered goal; plan revision; task confirmation; auditor enabled/disabled; rejection and approval; terminal changes reflected |
| Compatibility | Fresh image; existing workspace; existing old runner; conflicting extension version; unsupported checkpoint schema |

Suggested QA manifests for the later implementation:
`e2e/qa/cases/workspace-goals-direct.json`,
`workspace-goals-guided.json`, `workspace-goals-recovery.json`, and
`workspace-goals-ownership.json`. Compose existing login/setup scripts and follow
the `qa-test` skill when composing/running those cases. Save evidence under
`artifacts/qa/` and clean up test sessions/workspaces.

Run focused checks after each slice; run the existing aggregate once at final
integration:

```bash
npm run check
```

That includes docs checks, Functions and runner checks, frontend tests and the
full build. Add emulator authorization checks and local container integration
tests because unit tests cannot establish Firestore policy or process recovery.
Run live Pi QA on basic, web, and Chrome, plus targeted shell/Codex regressions
for changed shared runtime paths. No feature release if guided confirmation still
requires Terminal or a stopped workspace loses its goal history.

Measure browser-free progress beyond the configured idle timeout in a controlled
test. Verify Cloud Run CPU allocation supports background execution; minimum
instances alone are not sufficient proof. Integrate a bounded, lease-backed goal
liveness signal with the reaper. Waiting/paused/blocked goals must not keep renewing
execution indefinitely. Do not redefine ordinary WebSocket reconnects as activity.

## 13. Rollout and rollback plan

1. Add server/UI feature flags and backward-compatible routes. Keep execution off.
2. Deploy validated rules/indexes and Functions before the frontend exposes writes.
3. Build immutable candidate image tags and test them in controlled sessions.
4. Verify IAM and browser-free execution in the actual target project.
5. Enable a limited QA/internal rollout, then expose the feature generally.
6. Offer explicit restart/update for existing sessions. Existing revisions do not
   acquire image contents merely because a tag was rebuilt.

Future commands, to run only during the implementation rollout:

```bash
firebase deploy --only firestore:rules,firestore:indexes --project pi-agents-cloud
firebase deploy --only functions --project pi-agents-cloud
gcloud builds submit session-runner --config session-runner/cloudbuild.pi-basic.yaml --project pi-agents-cloud
gcloud builds submit session-runner --config session-runner/cloudbuild.pi-web.yaml --project pi-agents-cloud
gcloud builds submit session-runner --config session-runner/cloudbuild.pi-chrome.yaml --project pi-agents-cloud
firebase deploy --only hosting --project pi-agents-cloud
```

The shown build configs default to normal image tags. For candidate builds, set
their `_IMAGE` substitution to the intended immutable candidate tag and configure
the controlled session accordingly; do not accidentally replace a release tag
while calling it a canary. Rebuild additional affected non-Pi images if shared
runtime changes ship in them.

Production Functions must use
`mapache-api@pi-agents-cloud.iam.gserviceaccount.com`; runners must use
`mapache-runner@pi-agents-cloud.iam.gserviceaccount.com`. Preserve the API account's
`roles/iam.serviceAccountUser` on the runner account. Record actual deploy outcomes
in implementation handoffs, as required by the repository instructions.

Rollback: block new starts, quiesce/checkpoint active runs where possible, preserve
read-only history, and revert the app/Functions/images to the last compatible
release. Keep a checkpoint compatibility matrix and never let an older engine
rewrite a newer schema blindly. Do not delete goals or silently disable the bridge
while active processes keep executing. Retain diagnostics for unresolved runs.

At implementation time, add a canonical `docs/workspace-goals.md`, link it from
the wiki routing table, and update focused runtime/frontend/backend/harness/
deployment pages. Update `docs/ui-components.md` for new components. Keep this
plan clearly distinguished from shipped behavior. Run `npm run docs:check`.

## 14. Estimate and decision checklist

Planning estimate for one junior developer with regular senior review:

| Workstream | Working days |
| --- | --- |
| Prototype and compatibility decision | 2–4 |
| Contracts, image packaging, bridge | 7–12 |
| Checkpointing, backend ownership, lifecycle recovery | 10–16 |
| Dashboard, guided interactions, audit/settings UI | 7–12 |
| Integration QA, documentation, controlled rollout | 5–8 |
| Total before contingency | 31–52 |

Allow roughly 8–13 calendar weeks with review/rework, depending on the upstream
adapter result. Re-estimate after PR 0. A major Pi version migration or broad
workspace sync redesign changes this estimate materially.

Decisions to record before implementation progresses past its relevant gate:

- Exact Pi, extension, and bridge versions; supported upstream adapter versus fork.
- Complete structured-dialog inventory and restart reconstruction behavior.
- Checkpoint contents, generic-sync ownership, and workspace code consistency.
- Lease renewal, stop escalation, writer handoff, and reaper integration evidence.
- API payload limits, retention policy, supported settings and model validation.
- Actual background CPU behavior, candidate rollout mechanism, rollback versions.

Definition of done: the acceptance example works entirely in the web UI; goal
history remains available without a runner; interrupted runs resume from a verified
checkpoint through explicit user action; duplicate/stale operations cannot create
overlapping managed execution; authorization and failure tests pass; supported
images contain the pinned package; rollout and recovery are documented.

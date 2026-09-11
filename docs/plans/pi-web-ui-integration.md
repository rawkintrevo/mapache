# pi-web-ui integration plan

Status: agreed product boundaries; implementation pending. September 11, 2026.

Execution source of truth: [sequential checklist](../../task_list.md) and its
[task guide](./pi-web-ui-tasks/README.md), [fixed decisions](./pi-web-ui-tasks/decisions.md),
and [shared contracts](./pi-web-ui-tasks/contracts.md). The numbered phases below
are an architecture overview, not the execution order. The detailed checklist
migrates and validates HubSpot before removing legacy paths, so incremental
deployments can preserve the source session.

## Objective

Use pi-web-ui as Mapache's agent interface inside the sole supported runner,
pi-chrome. Retain Mapache's cloud workspace management and migrate the files and
Pi history of the existing HubSpot workspace's Chrome session once.

This plan supersedes the previous custom web-first direction. The local code
baseline is `d56f85db9b5a899341a23337fa4a7a78b254e9c2`; the rollback did not
roll back deployed services. Inspect deployed revisions before implementation rollout.

## Agreed decisions

| Area | Decision |
| --- | --- |
| Runner | Only pi-chrome; one active container per workspace |
| Conversations | Multiple conversations managed by pi-web-ui inside that container |
| Mapache ownership | Login, workspace management, provisioning, stop/restart, durable storage, saved credentials and external connections |
| pi-web-ui ownership | Chat, tools, terminal, files, Git controls, conversation history, models and agent settings, skills, extensions, subagents |
| Embedding | Embed the upstream app and server rather than porting individual React components |
| Other surfaces | Keep Persistent Chrome and app Preview alongside pi-web-ui |
| Goals | Adopt upstream conversation Goals; retire Mapache Workspace Goals and pi-goal-x |
| Browser closure | Execution continues while the runner remains running |
| Workspace stop | Stop execution and save state |
| Restart/replacement | Restore files, history, and settings; execution resumes only on explicit user action |
| Migration | Only the identified HubSpot Chrome session's files and Pi history; no browser profile, tabs, login state, old Goal state, or general compatibility framework |

The lifecycle guarantee applies to saved state. It does not promise continuation
of an interrupted tool process or an unsaved model turn after a container crash.

## Upstream baseline and maintenance

Reviewed [pi-web-ui](https://github.com/xing-shuyin/pi-web-ui) at commit
`46880b3772591beac91c0c1792bdc79a6fe3671f` (package version `0.79.0`). It uses
the Pi SDK in process, a React app, and an HTTP/WebSocket server. Mapache uses
React 19 while the reviewed upstream uses React 18; an iframe keeps their builds
and global state independent.

Implementation default: pin a tested upstream commit/release and dependencies,
retain MIT attribution, and maintain a small, reproducible patch set. Do not
install a floating latest version at runner startup. Record each patch's purpose
and run integration checks before deliberate upgrades. Start with upstream's
managed-deployment controls; do not assume they disable every overlapping editor.

Relevant upstream owners: `server/index.ts`, `server/agent-service.ts`,
`server/goal-service.ts`, `server/client-state.ts`, `server/protocol.ts`, and
`web/src/use-chat.ts`. Upstream Goals are a separate implementation from pi-goal-x;
do not translate or claim preservation of the old execution state.

## Target architecture

Mapache authenticates the workspace owner and issues short-lived runner access.
The runner gateway proxies an embedded pi-web-ui surface to a loopback-only
upstream server in the same pi-chrome container. Keep its internal port private.
The runner continues to own Chrome, preview, metrics, cloud storage, and lifecycle.

Add focused gateway and process-lifecycle modules under `session-runner/lib/`;
keep `session-runner/server.js` as their composition point. Add a focused iframe
component under `src/components/sessions/`, composed by `SessionDetail.jsx`.
Session provisioning remains in `functions/sessionCreation.service.js` and
`functions/cloudRun.service.js`. Catalog changes flow through the existing
generated catalog rather than parallel frontend constants.

The gateway must cover HTTP assets, downloads/uploads, and WebSocket upgrades;
preserve origin checks and authorize every exposed route. Use a narrowly scoped
bootstrap token/cookie flow compatible with cross-site embedding and renewal.
Do not expose backend shutdown tokens or turn an upstream client ID into an
authorization identity. Verify asset base paths, service-worker scope, reconnect,
iframe cookies, and expired-token handling with a real browser.

Mapache materializes selected credentials and connection configuration before
the upstream runtime starts. Disable or adapt overlapping upstream credential
and connection mutations on the server as well as in the UI. Select exactly one
MCP loading path so tools are not duplicated. Agent settings belong to pi-web-ui
and must not be overwritten by legacy bootstrap or synchronization logic.

One pi-web-ui runtime owns agent conversations; do not auto-start the former Pi
TUI or Goals RPC process. Its terminal is a shell/tool surface. Concurrent
conversations may edit the same workspace, as upstream supports; this does not
provide isolated per-conversation worktrees.

## Implementation sequence

### 1. Prove the embedded runtime boundary

- Build the pinned upstream app/server into pi-chrome; preserve Chrome and preview dependencies.
- Start upstream only after workspace restore and credential materialization.
- Implement the authenticated gateway and iframe using focused modules.
- Verify a real streamed turn, tool output, shell, file access, reconnect, and a native Goal.
- Verify credentials/connections work through the chosen Pi SDK/MCP path.
- Check native Goals, extensions, settings, and session restore for unexpected automatic execution.

Exit: a working vertical slice in an isolated test workspace, including authenticated
embedding and rejection of unauthorized HTTP and WebSocket access. Resolve upstream
patch requirements here before expanding integration.

### 2. Enforce one runner and durable lifecycle

- Restrict creation to pi-chrome and remove image selection and SSH creation paths.
- Use a transactional workspace reservation to serialize concurrent create/restart requests.
- Prevent overlapping writers during Cloud Run revision replacement; max instances alone is insufficient.
- Persist workspace files, Pi session JSONL, and pi-web-ui settings/state under explicit workspace-owned storage targets.
- Determine upstream session discovery paths and restore all state before accepting clients.
- Serialize periodic saves and final shutdown saves; drain/abort active work on explicit stop.
- Persist native Goal information needed for display after restart without automatically restarting its review loop; patch upstream only if necessary.
- Audit Cloud Run CPU allocation, instance lifetime, request timeout, and reconnect behavior so execution does not depend on an open browser connection.
- Define and document checkpoint cadence and crash-loss bounds; surface failed saves rather than reporting successful persistence.
- Keep cloud SDK clients on the runner metadata identity, separate from workspace credentials.

Exit: duplicate start requests cannot create two active writers; closing all browser
tabs leaves work running; stop/restart and forced replacement restore saved state
without generating a new turn automatically.

### 3. Complete the product surface and retire duplicate controls

- Make pi-web-ui the primary session canvas, retaining Persistent Chrome, Preview, and resource metrics.
- Remove old Terminal/Chat, session-level file/Git controls, and agent-settings editors now owned upstream.
- Keep Mapache credentials/connections and workspace lifecycle controls accessible.
- Remove Mapache Goals UI/routes/runtime integration and managed pi-goal-x installation.
- Remove obsolete runner catalog entries, image build paths, and harness-specific product flows.
- Check build inheritance before removing Dockerfiles: pi-chrome must retain its dependencies.
- Replace obsolete tests with tests of the final product boundaries; avoid maintaining dormant alternate runner implementations.

Exit: one clear owner for each setting/action, no visible runner selector or legacy
Goals entry point, and working Chrome/Preview beside the embedded app.

### 4. Migrate the HubSpot session once

- Identify and record the exact workspace/session IDs; do not select solely by display name.
- Inspect its actual Pi version, transcript layout, storage prefixes, and live files.
- Capture a consistent backup of workspace files (including hidden files and `.git`, if present) and that session's complete Pi history. Quiesce writes during the final capture.
- Back up live state as well as checking remote archives; do not assume the latest files are already synchronized.
- Produce a manifest with hashes and transcript/session counts. Keep the original backup unchanged.
- Restore into an isolated target first. Map the old `PI_SESSION_DIR` layout (`mapache-sessions/<sessionId>` by default) into upstream's SDK discovery layout, preserving IDs, branches, and messages.
- Reconcile obsolete managed declarations such as pi-goal-x only in the working copy; preserve their original files in the backup.
- Verify every backed-up file against the manifest, accounting explicitly for intentional configuration changes; verify history listing, representative old messages, and an explicit resumed turn.
- Retain the existing workspace identity and Mapache-managed connections. Do not import Chrome profile data or old Goal execution state.
- Switch the workspace to the new runner only after validation; keep the old runner stopped and the backup recoverable until acceptance.

Exit: the HubSpot workspace's files and Pi history are usable in pi-web-ui. A small
one-off import script/runbook is sufficient. No Codex/SSH conversion or bulk migration.
Never run old and new containers against the same writable storage prefix simultaneously.

### 5. Validate, deploy, and document

- Run focused gateway, lifecycle, storage, provisioning-race, and frontend tests, then `npm run check`.
- Use the repository QA skill for hosted browser cases: streamed turns, concurrent conversations, terminal, files/Git, Goals, credentials/MCP, Chrome, Preview, token renewal, and restart recovery.
- Exercise cross-workspace access rejection, browser disconnect during work, failed checkpoints, forced container replacement, and explicit resume behavior.
- Rehearse the HubSpot import against an isolated backup before final cutover.
- Inspect current deployed resources because local rollback did not revert production. Build pi-chrome with a recorded immutable digest and explicit `--project pi-agents-cloud`.
- Deploy changed Functions with `firebase deploy --only functions:api --project pi-agents-cloud`; deploy Hosting with the same explicit project after API compatibility is established.
- Preserve API identity `mapache-api@pi-agents-cloud.iam.gserviceaccount.com` and runner identity `mapache-runner@pi-agents-cloud.iam.gserviceaccount.com`, including the API's actAs grant.
- Existing services require a new revision/recreation to acquire the image. Perform the final migration while the old workspace runner is stopped.
- Update frontend, runtime, session-runner, backend, harness, Goals, deployment, testing, and UI-component docs to describe implemented behavior; mark superseded plans explicitly.

Release exit: all lifecycle and browser checks pass; HubSpot files/history validate;
deployment commands, image digest, backup location, and rollback procedure are recorded.

## Rollback and scope limits

Keep the source backup and previous image/deployment identifiers until the migrated
workspace is accepted. Rollback first stops the new writer, preserves any new work,
and restores the prior deployment/data into a single active runner. Never overwrite
new conversations or files silently with the pre-migration snapshot.

No general backward compatibility, live tool-process migration, old Goal-state
conversion, browser-profile migration, or additional runner family is required.
The earlier half-day-to-day migration estimate is provisional for the one-off
import only; validate it after inspecting the actual session backup. This plan
does not estimate the full integration based on that migration estimate.

## Related context

- [Frontend architecture](../frontend-architecture.md)
- [Session runner architecture](../session-runner-architecture.md)
- [Runtime containers](../runtime-containers.md)
- [Existing Workspace Goals](../workspace-goals.md)
- [Wiki update protocol](../wiki-update-protocol.md)

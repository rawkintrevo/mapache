# pi-web-ui sequential task list

Goal: integrate pi-web-ui into the sole pi-chrome runner, with one active runner
per workspace, and preserve the HubSpot Chrome session's files and Pi history.

Status: implementation in progress; Tasks 1–11 are complete. These are local
issue specifications, not GitHub issue numbers. Each link contains the task's
starting files, implementation steps, acceptance criteria, validation, and scope limits.

## Start here

- [Execution guide and suggested implementation-agent goal](docs/plans/pi-web-ui-tasks/README.md)
- [Fixed product decisions and selected engineering defaults](docs/plans/pi-web-ui-tasks/decisions.md)
- [Shared interfaces, storage, auth, and lifecycle contracts](docs/plans/pi-web-ui-tasks/contracts.md)
- [Architecture overview](docs/plans/pi-web-ui-integration.md)

Execute the first unchecked task, in numeric order. All earlier tasks are prerequisites.
For a whole-checklist goal, verify and commit each task, then continue automatically.
For a single `next task` request, complete one task. Never mark failed or blocked work
complete, skip a prerequisite, or invent a missing source ID/credential. Follow the
linked stop rules. No further product decisions are queued; missing external access
or contradictory evidence still requires an explicit stop.

Difficulty: **easy** means inspection or a small focused change; **medium** means a
bounded implementation with the design already specified and meaningful tests.
These are not timing guarantees. Split oversized work into local lettered steps
within its task file while keeping the root task unchecked.

## Ordered checklist

- [x] 1. **[Inventory the deployment and identify the HubSpot source](docs/plans/pi-web-ui-tasks/01-inventory-and-protect-source.md)** - easy
  - Completed: 2026-09-11 — identified exactly one HubSpot source mapping (`rFNToErGqhiRT5Twt8vx` / `Q2ApeoyTMGQ7q26MNbhn`), recorded production Functions/Hosting/Cloud Run/image state, verified the seven source-session JSONL files (2,485 valid records), and created ignored recovery targets. No deployment, runner stop, or data copy performed. Evidence: `artifacts/qa/pi-web-ui/task-1/README.md`; restricted inventory: `artifacts/migrations/pi-web-ui/hubspot/2026-09-11-inventory.md`. Task 2 must reconcile the stored runner digest/runtime failure before cutover.
- [x] 2. **[Add the pinned upstream build and patch manifest](docs/plans/pi-web-ui-tasks/02-pin-upstream-build.md)** - medium
  - Completed: 2026-09-11 — added `session-runner/upstream/pi-web-ui/manifest.json`, ordered strict patching, reproducible source-fetch/build helper, and the pinned `pi-chrome` Docker integration. Verified the requested upstream commit/package (`46880b3` / `0.79.0`), Pi SDK `0.84.4`, adapter `2.32.1`, generated server/web output, LICENSE, and safe build descriptor. Upstream typecheck and 636 tests passed; helper negative tests passed; local Docker build and Chrome smoke passed. No cloud runner launch or deployment performed. Handoff: Task 3 can use `/opt/mapache/pi-web-ui`; existing Cloud Run services still need a later revision.
- [x] 3. **[Configure the managed app for the agent subpath](docs/plans/pi-web-ui-tasks/03-managed-embedded-build.md)** - medium
  - Completed: 2026-09-11 — added the pinned `/agent/` Vite base, fixed the favicon root-relative exception, preserved the existing `appUrl` API/WS/theme/plugin/file-preview mappings, removed service-worker registration with exact app-scope cleanup, and forced managed instances to the Pi engine while refusing self-update/runtime-install/plugin-catalog protocol messages. Upstream typecheck and 636 tests passed; generated bundle inspection, local HTTP load, managed health, and direct WebSocket refusal checks passed. Evidence: `artifacts/qa/pi-web-ui/task-3/README.md`. No Cloud Run service was launched, stopped, or deployed; Tasks 4–6 own the supervised process and public gateway mapping.
- [x] 4. **[Launch pi-web-ui as a supervised runner child](docs/plans/pi-web-ui-tasks/04-launch-upstream-process.md)** - medium
  - Completed: 2026-09-11 — added the marked-runtime config/state contract and `session-runner/lib/piWebUiProcess.js`, which starts exactly one loopback-only pinned child after restore/materialization, waits for authenticated local health, and performs bounded SIGTERM/SIGKILL shutdown without respawn or token logging. Marked runners disable the legacy Pi PTY/TUI, Chat, Goals bridge/RPC, and package declaration path; unmarked sessions retain existing behavior. Focused and aggregate session-runner tests passed (263 before the final Goals guard, then the focused guard test), lint and `npm run docs:check` passed, and local `Dockerfile.pi-chrome` build/Chrome smoke plus in-container managed health/stop smoke passed. Evidence: `artifacts/qa/pi-web-ui/task-4/README.md`. No Cloud Run service was launched or deployed. Task 5 should use the fixed internal `127.0.0.1:8787` process and marker/state paths; no storage or provisioning changes were made.
- [x] 5. **[Add the authenticated HTTP gateway for the embedded app](docs/plans/pi-web-ui-tasks/05-http-gateway.md)** - medium
  - Completed: 2026-09-11 — added the authenticated `/agent` HTTP gateway before the runner JSON parser, with signed session/audience/generation verification, scoped bootstrap cookie, private-token injection, exact-Origin mutation checks, traversal and redirect fencing, upstream-cookie filtering, streamed bodies, Range preservation, and a 10 MiB request bound based on the pinned upstream Express limit. Focused gateway/access tests passed (9), aggregate runner tests passed (269), lint and `npm run docs:check` passed. Evidence: `artifacts/qa/pi-web-ui/task-5/README.md`. No Cloud Run service was launched or deployed. Task 6 owns WebSocket forwarding.
- [x] 6. **[Proxy agent WebSockets alongside existing runner sockets](docs/plans/pi-web-ui-tasks/06-websocket-gateway.md)** - medium
  - Completed: 2026-09-11 — added `session-runner/lib/agentWebSocketGateway.js` and routed `/agent/ws` through the central noServer dispatcher to the fixed loopback `/ws`, with signed session/audience/generation/expiry and exact-Origin checks before upstream connection, private-token-only headers, query/cookie stripping, bounded message backpressure, paired close handling, and expiry fencing. Fake-upstream hello/ready/snapshot, terminal/metrics coexistence, rejection, and expiry tests passed; aggregate runner tests passed (271), lint and `npm run docs:check` passed. Evidence: `artifacts/qa/pi-web-ui/task-6/README.md`. No Cloud Run service was launched or deployed. Task 7 owns signed access API issuance.
- [x] 7. **[Expose gated signed agent access URLs from Functions](docs/plans/pi-web-ui-tasks/07-signed-agent-access-api.md)** - medium
  - Completed: 2026-09-11 — added server-owned `pi-web-ui-v1` workspace marking with an exact-target, owner-verified deployment helper; marked sessions force the curated `pi-chrome` image, propagate explicit runtime-generation metadata, and expose `agentUrl` only for owned running compatible sessions. Agent tokens use the existing browser secret/TTL with `aud: "agent"`, session ID, and generation; unmarked, unsupported, cross-owner, and missing-generation responses omit the URL. Client payloads cannot select the marker, image, or generation. Focused agent-runtime, access, session-creation, Cloud Run, and marker-helper tests passed; full Functions tests and lint passed; `npm run docs:check` checked 81 files successfully. Deployed with `firebase deploy --only functions --project pi-agents-cloud`: 6 Functions updated successfully, 0 errored; unrelated remote Functions were preserved. No QA workspace was marked because no explicit target was supplied. Evidence: `artifacts/qa/pi-web-ui/task-7/README.md`. Task 8 owns the embedded canvas and browser-side renewal.
- [x] 8. **[Embed the agent canvas and renew access without reload](docs/plans/pi-web-ui-tasks/08-iframe-and-renewal.md)** - medium
  - Completed: 2026-09-11 — added `PiWebUiCanvas` with a stable per-session iframe, Agent/Chrome/Preview tab persistence, loading/unavailable/access-error states, and a new-tab fallback. Added the pinned upstream `mapache.agent.*` postMessage bridge with exact origin/source validation, signed URL cookie renewal, expiry-triggered parent refresh, and existing WebSocket reconnect without iframe reload or prompt replay. Agent access URL updates are delivered by message while the iframe `src` stays fixed; session selection uses a keyed canvas so stale updates cannot cross sessions. Mapache frontend tests passed (44 files, 157 tests), root build and community build passed, upstream typecheck passed, upstream tests passed (70 files, 639 tests), upstream lint passed with three pre-existing warnings, fresh pinned patch verification passed, and `npm run docs:check` checked 81 files successfully. No deployment was required for this frontend/upstream bundle task. Evidence: `artifacts/qa/pi-web-ui/task-8/README.md`. Task 9 owns Mapache credential mutation enforcement.
- [x] 9. **[Keep credential mutations in Mapache](docs/plans/pi-web-ui-tasks/09-credential-ownership.md)** - medium
  - Completed: 2026-09-11 — `workspaceAuth.service.js` now treats Firestore plus session selection as authoritative for managed Pi, materializes selected credentials into `/var/lib/mapache/agent/pi/auth.json` after restore and before the supervised child, removes stale `provider-keys.json`, refuses to import restored legacy auth, and exposes a path-only capture-excluded secret inventory (`agent-auth`, `pi-provider-keys`, `pi-model-config`, `pi-mcp-oauth`, `github-cli-hosts`, and managed `legacy-pi-auth`). The pinned upstream managed server rejects provider-key/OAuth/secret-header mutations while retaining metadata-only model configuration and selection; the UI explains Mapache ownership and hides credential controls. Runner tests passed (273), upstream typecheck/tests/build passed (70 files, 641 tests), lint and `npm run docs:check` passed, and fresh patch verification passed. Evidence: `artifacts/qa/pi-web-ui/task-9/README.md`. No deployment was required because Functions code was unchanged. Task 10 should preserve this ownership boundary while connecting the single `pi-mcp-adapter` path through SDK discovery; use the existing `/workspace/.mcp.json` and Mapache token-refresh materialization contracts without duplicating credentials.
- [x] 10. **[Connect the existing MCP adapter to the SDK runtime](docs/plans/pi-web-ui-tasks/10-single-mcp-path.md)** - medium
  - Completed: 2026-09-11 — pinned `pi-mcp-adapter@2.32.1` is installed and patched into the Pi images, passed through `PI_WEB_MCP_ADAPTER_PATH`, and discovered exactly once by the managed upstream Pi SDK. The managed server skips its independent MCP bridge; adapter setup/editor, auth actions, project enable/disable, config writes, and bearer-token writes are refused while stdio/remote execution and Mapache’s Google `bearer_env` refresh path remain available. Unsupported adapter versions fail closed. The deterministic SDK fixture found one tool, executed one call, and recorded one server process; runner tests passed (276), upstream typecheck/tests/build passed (70 files, 641 tests), the root build/lint/docs checks passed, and the local `pi-chrome` image plus managed start/health/stop smoke passed. Evidence: `artifacts/qa/pi-web-ui/task-10/README.md`. No real HubSpot writes, hosted connector mutation, cloud runner launch, or deployment was performed. Task 11 should bind this single adapter-backed MCP config to workspace/history ownership without introducing a second connector path.
- [x] 11. **[Bind upstream projects and history to one workspace](docs/plans/pi-web-ui-tasks/11-workspace-binding.md)** - medium
  - Completed: 2026-09-11 — added the ordered upstream workspace/history patch and fixed managed pi-web-ui to `/workspace`, with an explicit flat `PI_CODING_AGENT_SESSION_DIR` passed to every SDK session create/continue/list/open operation. Project selection, path completion, folder creation, stale client-state restore, and history open/rename/delete now follow canonical paths and reject foreign roots or symlink escapes; the ordinary shell/PTY remains unrestricted. Client IDs retain display state only, so independent clients share transcript IDs and branches. The patch manifest now includes 0006 and 0007; pristine ordered verification and full build passed. Upstream typecheck/build passed, 71 files and 644 tests passed, session-runner tests passed (276 with 1 skip), session-runner lint, root build, and `npm run docs:check` passed (81 files). Evidence: `artifacts/qa/pi-web-ui/task-11/README.md`. No deployment, hosted runner launch, or workspace data mutation was performed. Task 12 can serialize runner-side workspace start requests against this fixed history root.
- [ ] 12. **[Serialize workspace Start requests](docs/plans/pi-web-ui-tasks/12-workspace-start-reservation.md)** - medium
- [ ] 13. **[Fence duplicate and stale runner instances](docs/plans/pi-web-ui-tasks/13-boot-instance-fencing.md)** - medium
- [ ] 14. **[Capture versioned agent-state snapshots](docs/plans/pi-web-ui-tasks/14-capture-agent-state.md)** - medium
- [ ] 15. **[Publish checkpoints without stale-writer overwrite](docs/plans/pi-web-ui-tasks/15-publish-checkpoints.md)** - medium
- [ ] 16. **[Restore saved state before starting the agent](docs/plans/pi-web-ui-tasks/16-restore-before-start.md)** - medium
- [ ] 17. **[Restore native Goal information in a paused state](docs/plans/pi-web-ui-tasks/17-persist-paused-native-goals.md)** - medium
- [ ] 18. **[Stop upstream agent and tool writers through a narrow control hook](docs/plans/pi-web-ui-tasks/18-quiesce-runtime.md)** - medium
- [ ] 19. **[Schedule saves and require a final checkpoint on manual Stop](docs/plans/pi-web-ui-tasks/19-checkpoint-and-stop.md)** - medium
- [ ] 20. **[Make Cloud Run lifetime independent of browser traffic](docs/plans/pi-web-ui-tasks/20-cloud-run-lifecycle.md)** - medium
- [ ] 21. **[Show runtime and persistence failures in the session shell](docs/plans/pi-web-ui-tasks/21-recovery-status-ui.md)** - medium
- [ ] 22. **[Verify the complete local runtime before cloud rollout](docs/plans/pi-web-ui-tasks/22-local-vertical-slice.md)** - medium
- [ ] 23. **[Build the one-off HubSpot export and manifest tool](docs/plans/pi-web-ui-tasks/23-one-off-export-tool.md)** - medium
- [ ] 24. **[Import and validate HubSpot files and history](docs/plans/pi-web-ui-tasks/24-one-off-import-tool.md)** - medium
- [ ] 25. **[Write bounded hosted QA cases and migration checks](docs/plans/pi-web-ui-tasks/25-compose-hosted-qa.md)** - medium
- [ ] 26. **[Deploy a pinned canary and preview UI](docs/plans/pi-web-ui-tasks/26-deploy-isolated-canary.md)** - medium
- [ ] 27. **[Run hosted functional browser QA](docs/plans/pi-web-ui-tasks/27-hosted-functional-qa.md)** - medium
- [ ] 28. **[Run hosted persistence and failure-recovery QA](docs/plans/pi-web-ui-tasks/28-hosted-lifecycle-qa.md)** - medium
- [ ] 29. **[Rehearse the one-off migration from a consistent source backup](docs/plans/pi-web-ui-tasks/29-rehearse-hubspot-migration.md)** - medium
- [ ] 30. **[Move the HubSpot workspace to the validated runner](docs/plans/pi-web-ui-tasks/30-cut-over-hubspot.md)** - medium
- [ ] 31. **[Make the embedded app the primary workspace surface](docs/plans/pi-web-ui-tasks/31-simplify-workspace-shell.md)** - medium
- [ ] 32. **[Make pi-chrome the sole backend creation path](docs/plans/pi-web-ui-tasks/32-default-pi-chrome-backend.md)** - medium
- [ ] 33. **[Remove the old Chat, Goals, and duplicate agent controls](docs/plans/pi-web-ui-tasks/33-retire-legacy-agent-controls.md)** - medium
- [ ] 34. **[Remove unsupported runner families and build paths](docs/plans/pi-web-ui-tasks/34-retire-other-runner-builds.md)** - medium
- [ ] 35. **[Validate the final code and reconcile developer documentation](docs/plans/pi-web-ui-tasks/35-final-validation-and-docs.md)** - medium
- [ ] 36. **[Publish and verify the final one-runner release](docs/plans/pi-web-ui-tasks/36-publish-final-release.md)** - medium
- [ ] 37. **[Clean up QA resources and close the implementation checklist](docs/plans/pi-web-ui-tasks/37-cleanup-and-handoff.md)** - easy

## Completion notes

Add each task's dated Completed or Blocked note immediately below its checkbox,
including verification and deployment outcome when applicable. Store sensitive
migration inventories/backups outside Git. Keep screenshots/traces in the ignored
artifact locations specified by the execution guide.

## Previous checklist

The completed developer-wiki refactor checklist is preserved in
[the historical archive](docs/prior_task_lists/developer-wiki-refactor-completed-2026-06-17.md).
It is not part of this implementation goal.

# pi-web-ui sequential task list

Goal: integrate pi-web-ui into the sole pi-chrome runner, with one active runner
per workspace, and preserve the HubSpot Chrome session's files and Pi history.

Status: planning complete; all implementation tasks are unstarted. These are local
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
- [ ] 3. **[Configure the managed app for the agent subpath](docs/plans/pi-web-ui-tasks/03-managed-embedded-build.md)** - medium
- [ ] 4. **[Launch pi-web-ui as a supervised runner child](docs/plans/pi-web-ui-tasks/04-launch-upstream-process.md)** - medium
- [ ] 5. **[Add the authenticated HTTP gateway for the embedded app](docs/plans/pi-web-ui-tasks/05-http-gateway.md)** - medium
- [ ] 6. **[Proxy agent WebSockets alongside existing runner sockets](docs/plans/pi-web-ui-tasks/06-websocket-gateway.md)** - medium
- [ ] 7. **[Expose gated signed agent access URLs from Functions](docs/plans/pi-web-ui-tasks/07-signed-agent-access-api.md)** - medium
- [ ] 8. **[Embed the agent canvas and renew access without reload](docs/plans/pi-web-ui-tasks/08-iframe-and-renewal.md)** - medium
- [ ] 9. **[Keep credential mutations in Mapache](docs/plans/pi-web-ui-tasks/09-credential-ownership.md)** - medium
- [ ] 10. **[Connect the existing MCP adapter to the SDK runtime](docs/plans/pi-web-ui-tasks/10-single-mcp-path.md)** - medium
- [ ] 11. **[Bind upstream projects and history to one workspace](docs/plans/pi-web-ui-tasks/11-workspace-binding.md)** - medium
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

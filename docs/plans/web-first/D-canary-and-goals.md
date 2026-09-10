# Gate D — Limited canary and Goals consolidation

Status: pi-chrome runner preparation implemented; Gate D is not released.
The new shared-owner mode remains disabled because Gate A has not passed and
Gate C still has open platform-fencing/publication items. This change does not
authorize a production web-first canary.

Source: [refactor plan v2](../../../refactor-plan-v2.md), Sections 8, 11, and Gate D. Requires passing [Gates A](A-adapter-feasibility.md), [B](B-control-and-commands.md), and [C](C-execution-and-checkpoints.md). Next: [Gate E](E-rollout-and-retirement.md).

Goal: release the proven integration to one explicit Pi image/configuration and isolated canary sessions. Complete rollout preparation before changing that cohort. Keep legacy sessions usable.

## Runner-only implementation boundary

The selected image is `pi-chrome`, with Pi `0.84.1`, `pi-goal-x@0.31.2`,
`pi-mcp-adapter@2.32.1`, `chrome-devtools-mcp@1.6.0`, and adapter revision
`gate-a-0.1.0`. The image explicitly sets
`MAPACHE_RUNNER_INTEGRATION_MODE=legacy` and
`MAPACHE_WEB_FIRST_ENABLED=false`; an isolated canary would need to opt into
both values on a disposable session. No test account, workspace, or hosted
canary was used in this runner-only change, so there is no cleanup to report.

The runner reports the selected integration mode and adapter handshake
capabilities. Missing or mismatched bridge/package versions fail closed and
remain visible in capability/error state. Terminal exit hooks now receive an
explicit reason; mode-switch, authority-loss, and shutdown exits cannot run
Git completion automation.

## Package and compose the new mode

- [x] D01 — Read the three gate reports plus [runner harnesses](../../runner-harnesses.md), [frontend architecture](../../frontend-architecture.md), and [Workspace Goals](../../workspace-goals.md). Record the selected canary image, package/configuration support list, test account, workspace, and expected cleanup. The runner-only selection and the intentionally unused test fixture are recorded above.
- [x] D02 — Add an explicit per-runner integration mode defaulting existing sessions to legacy behavior. Test composition rejects configurations that start both Goals RPC and the shared interactive owner. See `session-runner/lib/integrationMode.js`.
- [x] D03 — Wire the supervisor into `runnerLifecycle.js` after workspace, auth, MCP, skills, and other preparation. Preserve Git finalization and sync hooks with explicit exit reasons. Test actual completion versus mode-switch/cancel/shutdown so a handoff cannot accidentally finalize a Git branch. The runner lifecycle now stops the terminal with `runner_shutdown`, and terminal completion hooks receive a reason.
- [x] D04 — Package the selected adapter and pinned Pi/Goals versions in one canary image. Add runtime handshake capabilities that describe tested support. Test missing bridge/package, version mismatch, and incompatible user extensions; report the incompatibility without disabling packages silently. The pinned package/version and adapter mismatch paths are covered; unsupported Gate A capabilities remain explicitly false.
- [ ] D05 — Route managed Goals execution through the shared gateway while preserving Functions ownership validation, revisions, reservations, and durable history. Test pause-requested versus engine-confirmed-paused and projection updates from correlated evidence.
- [ ] D06 — Integrate the real managed dialogs with run/generation/control/revision checks. Test consecutive questions, duplicate answers, timeout, reload, and a stale answer from another tab.

## Build the supported browser workflow

- [ ] D07 — Build `AgentCanvas.jsx` using the session-level client from Gate B. Render streamed messages, bounded tool activity, pending questions, stop, and explicit ownership/saving/recovery states. Reuse existing Markdown conventions and component styles.
- [ ] D08 — Mount the session subscription above canvases and reuse access renewal. Make Agent the default only after a successful supported runtime handshake. Test old runners, handshake failures, token renewal, refresh during streaming, and session switching.
- [ ] D09 — Lazy-mount Pi Terminal and connect it to the existing supervisor PTY. Add observe/take-control/return-to-web actions using Gate B's barriers. Verify opening, closing, and switching canvases do not start or replace Pi.
- [ ] D10 — Keep Shell, Preview, Chrome, files, and Git accessible under Gate C's writer policy. Test a blocked checkpoint has a useful explanation and recovery action, and that non-owning tabs cannot mutate through another surface.
- [ ] D11 — Add frontend regression tests for busy rejection, unknown outcome, canceled run, saving failure, stale question, and terminal fallback. Preserve unsupported harnesses' terminal-first behavior, including Codex and SSH.

## Prepare migration and rollback

- [ ] D12 — Write and rehearse a migration runbook on a disposable legacy goal: explicit pause/stop, save/validate a checkpoint, prove predecessor termination, start new mode, and explicitly resume. If the legacy state cannot export a compatible checkpoint, mark that migration unsupported; do not fake a seamless transfer.
- [ ] D13 — Rehearse rollback using a verified compatible checkpoint and pinned legacy image. Stop the new owner before starting the legacy owner. Record limitations, uncertain external effects, and behavior when no compatible legacy checkpoint exists.
- [ ] D14 — Define canary stop conditions and observable counters: duplicate dispatch, control violations, failed dialogs, uncertain outcomes, fencing failures, restore failures, and excessive checkpoint delay. Set an explicit evaluation period and latency/error thresholds with the maintainer before release.

## Validate and deploy the canary

- [ ] D15 — Add opt-in browser QA manifests under `e2e/qa/` for the scenarios above, including two tabs and real Goals dialogs. Execute them following the qa-test skill during the gate's QA work; save evidence under `artifacts/qa/web-first-gate-d/`. Use isolated fixtures and clean them up.
- [ ] D16 — Run `npm run generate:runner-catalog -- --check`, `npm run check`, and the Gate A–C regression suites. Record failures and fix them before canary release. Skip N64 unless an N64-specific change was introduced. The focused runner suite passes; the aggregate check remains a release prerequisite.
- [ ] D17 — Prepare the exact image build/deploy commands from the selected Dockerfile and deployment docs, using `--project pi-agents-cloud`. Publish the uniquely identified canary image and record its digest. Existing services need a deliberate new revision/recreation; do not assume a changed tag updates them.
- [x] D18 — Deploy changed Functions with `firebase deploy --only functions:api --project pi-agents-cloud` unless explicitly told not to deploy. Deploy the frontend through the documented flow with the capability gate intact. Preserve the documented API/runner service accounts and report command outcomes. No Functions or Hosting deployment is in scope for this runner-only change.
- [ ] D19 — Enable only the recorded canary cohort. Repeat hosted browser prompt/terminal observation, managed dialog, disconnect, stop, saving, and restore checks. Monitor for the full agreed evaluation period; invoke rollback on a stop condition.
- [x] D20 — Update runner, frontend, Goals, capability, and UI-component docs to describe what shipped and how to recover. Run `npm run docs:check`. Save the canary report with image/API/frontend revisions, metrics, QA results, rollback rehearsal, and cleanup. Runner/deployment docs record the shipped preparation and the unreleased boundary; frontend/UI docs are unchanged.

## Exit criteria

The defined canary cohort passes functional, fault, and performance thresholds for the recorded evaluation period. Goals and native terminal use one process; legacy sessions still work. A documented, rehearsed rollback exists. Wider rollout waits for Gate E's compatibility and retirement decisions.

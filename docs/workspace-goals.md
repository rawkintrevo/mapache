# Workspace Goals

Workspace Goals is the workspace-level web dashboard for saved goals backed by
the prebaked `pi-goal-x` extension in supported Pi runner images.

## Current implementation

The current release slice supports `pi-basic`, `pi-web`, and `pi-chrome`. Those
images install the pinned `pi-goal-x@0.31.2` package during image build and set
the `goals` catalog capability. On runner startup,
`session-runner/lib/goalsPackageBootstrap.js` reconciles the managed declaration
after home restore without downloading packages or replacing unrelated Pi
settings.

The backend stores drafts and normalized goal summaries under
`workspaces/{workspaceId}/goals`. `functions/goals.service.js` owns validation,
revision checks, workspace execution reservations, idempotent operation records,
runner delivery, lifecycle transitions, and bounded event history. The routes
are registered by the shared API manifest under
`/api/workspaces/{workspaceId}/goals` and include list, create, read, draft
update, typed actions, question answers, events, and operation recovery.

`src/components/goals/WorkspaceGoalsPanel.jsx` renders the workspace-level
dashboard in the workspace overview and inside a selected Pi session after the
user presses Goal below the terminal or Chat canvas. The selected-session entry
point passes the current session as the default Start/Resume target. A user can
save a draft without starting a runner, choose a compatible Pi session, and send
Start, Pause, Resume, or Archive through the backend. A session choice is only
selection; changing the dropdown never starts execution.

The runner exposes backend-protected `/goals/capabilities`, `/goals/snapshot`,
`/goals/commands`, and `/goals/operations/:operationId` routes. On the three
supported Pi images, `goalsRpc.service.js` starts one headless Pi RPC process
for managed goals and relays bounded `select`, `confirm`, `input`, and `editor`
requests to the dashboard. The existing terminal PTY remains available for
ordinary terminal work, but it cannot be opened while the managed RPC process
is active because both processes would otherwise write the same Pi session.
When Start/Resume finds an open terminal, the dashboard keeps the error visible
and offers an explicit **Stop Terminal/Chat and start/resume goal** action.
This sends `takeOverTerminal: true` through Functions, blocks new terminal
attachments, and waits for the Pi PTY to exit before starting RPC. Handoff does
not invoke the terminal completion hook (which can finalize a Git branch).
It sends SIGTERM first, escalates to SIGKILL after five seconds if interactive
extension cleanup stalls, and fails after ten seconds without a confirmed exit.
Saved history and files remain; in-flight terminal work is interrupted only
when the user selects that action. A failed or timed-out handoff never starts
a second writer.

Runtime snapshots contain the RPC state under `runtime`, including pending
questions, the latest bounded message, and errors. The dashboard reads that
nested state and updates its goal revision from each successful answer response
before sending another answer. An extension command that asks a dialog before
its final prompt response is acknowledged as delivered when that dialog arrives,
allowing Functions to assign the goal and the browser to answer it. Late model
failures stay visible in runtime state; command acceptance alone does not prove
that the model completed a turn.

The runner now reports its explicit integration mode and owner boundary in the
Goals capabilities response. `pi-chrome` ships in `legacy` mode, where the
headless Pi RPC owner is the supported Goals transport. The shared web-first
owner is opt-in only and does not start the legacy Goals RPC process alongside
it. Adapter/package incompatibilities are surfaced as compatibility failures;
unsupported web-first capabilities remain disabled rather than falling back to
PTY prompt injection.

## Deliberate release boundary

This slice covers the normal guided dialog transport and the initial dashboard,
but it is still a controlled release. The image build applies a small
RPC-specific compatibility patch to pi-goal-x's task confirmation dialog;
future pi-goal-x upgrades must be checked against that patch. Durable Cloud
Storage checkpoints, runner event ingestion, lease renewal and epoch fencing,
cross-session writer handoff, stale-process reconciliation, detailed task/evidence/audit
panels, and full recovery QA remain follow-up work.

Do not enable a general release until the plan's recovery and fault-injection
gates pass. A runner restart still requires an explicit Resume action, and the
dashboard reports the last server-saved goal projection rather than claiming
that an in-progress model turn is durable.

## Web-first Gate A boundary

The disposable `pi-chrome` Gate A fixture is a feasibility probe, not a second
production Goals transport. It proves that a private IPC adapter can address
the same TUI Pi process and deliver an ordinary user message while preserving
the PTY owner across reconnects. Gate A is not passed: the public TUI extension
API does not provide command expansion, external answers for native dialogs,
reload/session replacement, or a supported delegation path for those controls.
The candidate therefore stays disabled, and the existing headless RPC process
plus explicit terminal handoff remains the supported Goals mode.

## Ownership and safety rules

- Functions is authoritative for workspace ownership, revision validation,
  operation idempotency, and the one-managed-goal execution reservation.
- The browser never receives runner shutdown credentials or arbitrary command
  execution. Runner goal routes require the existing backend shutdown-token
  gate.
- A catalog capability does not prove that an already-running session has the
  new routes. Existing sessions need restart/recreation on an image containing
  the managed package and bridge.
- Goal summaries and events are bounded projections. Do not write model
  transcripts or unvalidated client task trees into Firestore.
- Keep the managed package pinned and avoid loading a second `pi-goal-x` copy
  from restored workspace settings.

## Verification and rollout

Use the focused goal tests alongside the repository aggregate:

```bash
npm run generate:runner-catalog -- --check
npm run docs:check
npm run check
```

Functions code was deployed with:

```bash
firebase deploy --only functions:api --project pi-agents-cloud
```

The API deployment completed successfully as revision `api-00185-vir` on
September 9, 2026. The existing Pi image tags are rebuilt in place for each
release and pushed to Artifact Registry; no separate Goals container is used.
The release digests are:

- `:pi-basic` — `sha256:c657bfc57cef0563f39cf345a321707227b570313b961ecd80f765e517f73d43`
- `:pi-web` — `sha256:939445be9a5e57ec86c6468a3c2b099923447b268a847e30e989d45558af9582`
- `:pi-chrome` — `sha256:be3517fcd42ef2996250bf1169eaa2ac72b1b47c4fdf54b5328d991c16efe79e`

Firebase Hosting release `e5ffb4a1f605450b` is live at
`https://pi-agents-cloud.web.app`. The public API smoke check returns HTTP 401
without an auth token, confirming that the new routes remain authenticated.

There is no separate Goals container. Existing Cloud Run sessions do not
acquire the new image contents until they are restarted or recreated.

See [the implementation plan](./plans/pi-workspace-goals.md) for the staged
prototype, persistence, lifecycle, browser, testing, and rollback requirements.

## September 9 Start-flow repair

Production Start requests were rejected with `goal_terminal_process_active`,
and the error was cleared by the UI's automatic refresh. Goal card buttons also
inherited white text on their transparent background. The repair retains action
errors, provides the explicit terminal handoff, uses shared button variants and
theme colors, handles nested runtime dialogs, and refreshes the revision after
answers. Browser regression instructions are in
`e2e/qa/cases/workspace-goals-start.json`; results belong under
`artifacts/qa/goals.start/`. Existing sessions need Restart after the repaired
Pi images are published.

The hosted Chrome regression passed on September 9: title contrast was 16.29:1
before hover, the initial terminal conflict stayed visible, the explicit
handoff returned HTTP 200, and two consecutive native Pi question answers
returned HTTP 200. The run reported no browser console errors and deleted its
isolated QA session and workspace. The repository aggregate check passed;
after adding the stalled-shutdown fallback, all 257 runner tests and runner
syntax checks passed again.

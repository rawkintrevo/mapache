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

## Deliberate release boundary

This slice covers the normal guided dialog transport and the initial dashboard,
but it is still a controlled release. The image build applies a small
RPC-specific compatibility patch to pi-goal-x's task confirmation dialog;
future pi-goal-x upgrades must be checked against that patch. Durable Cloud
Storage checkpoints, runner event ingestion, lease renewal and epoch fencing,
writer handoff, stale-process reconciliation, detailed task/evidence/audit
panels, and full recovery QA remain follow-up work.

Do not enable a general release until the plan's recovery and fault-injection
gates pass. A runner restart still requires an explicit Resume action, and the
dashboard reports the last server-saved goal projection rather than claiming
that an in-progress model turn is durable.

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

The API deployment completed successfully as revision `api-00183-wab` on
September 9, 2026. The existing Pi image tags are rebuilt in place for each
release and pushed to Artifact Registry; no separate Goals container is used.
The release digests are:

- `:pi-basic` — `sha256:372d8c4dd3d8bb13b6c4ab571f48d74ce75acaff74e3075ce86dffae33f397e9`
- `:pi-web` — `sha256:21c70857addba738dea33b466774aaa08cb2c26782e04b55191466bfc5256501`
- `:pi-chrome` — `sha256:97e86b285cdba12964a501c075296379a3d0c767b83144de2287c701f707f684`

Firebase Hosting release `e4a67873dca2a629` is live at
`https://pi-agents-cloud.web.app`. The public API smoke check returns HTTP 401
without an auth token, confirming that the new routes remain authenticated.

There is no separate Goals container. Existing Cloud Run sessions do not
acquire the new image contents until they are restarted or recreated.

See [the implementation plan](./plans/pi-workspace-goals.md) for the staged
prototype, persistence, lifecycle, browser, testing, and rollback requirements.

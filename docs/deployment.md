# Deployment

## Purpose

This page owns Firebase Hosting, Cloud Functions, Cloud Run runner image, CI, and service-account deployment assumptions.

## Read When

Read this before changing Firebase config, deployment workflows, Cloud Functions service accounts, Cloud Run runner image selection/provisioning, Firestore/Storage rules, or GitHub Actions deployment behavior.

## Canonical Owner

- Firebase config: `firebase.json`, `.firebaserc`
- Firestore rules/indexes: `firestore.rules`, `firestore.indexes.json`
- Storage rules: `storage.rules`
- Production/preview CI: `.github/workflows/firebase-production.yml`, `.github/workflows/firebase-preview.yml`
- Functions deploy config: `functions/backendConfig.js`, `functions/.env.pi-agents-cloud`
- Runner images: `session-runner/Dockerfile*`, `session-runner/cloudbuild*.yaml`

## Current Behavior

Asynchronous runtime resize uses the `resizeQueuedSession` Firestore-triggered
function in addition to `api`. Deploy `functions:resizeQueuedSession` before
`functions:api`, then Hosting, when introducing this queue. The worker inherits
the API service account and provisioning secrets and uses a 540-second timeout
with event retries; its ten-minute claim prevents overlapping invocations.

Firebase Hosting serves the Vite app from `dist/`, rewrites `/api/**` to the `api` Cloud Function, rewrites `/app` and `/app/**` to the app shell, and serves the Docusaurus community build under `/community/**`.

The `/api/**` rewrite also serves public shared website previews at `/api/public-previews/{token}/...`. Those requests are intentionally unauthenticated and are authorized by unguessable preview tokens plus `publicPreviews/{token}` metadata. Deploying Share Preview or browser QA contract changes requires the Cloud Functions API revision and a rebuilt `pi-chrome` runner revision; existing running sessions need restart/recreation before they receive the new behavior.

The disposable failure-recovery injector is part of the shared runner and Functions revisions. Deploy the Functions revision before calling the session-scoped fault API, and rebuild/recreate the disposable `pi-chrome` session before hosted QA so it contains the runner routes. The injector is marker- and environment-gated; it is unavailable on ordinary sessions and does not move the production `pi-chrome` tag by itself.

The repo targets the `pi-agents-cloud` Firebase/GCP project. Use explicit project flags for remote build and deploy commands:

```bash
firebase deploy --only hosting --project pi-agents-cloud
firebase deploy --only functions --project pi-agents-cloud
gcloud builds submit session-runner --project pi-agents-cloud --tag us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:latest
```

The catalog exposes one supported runner image, `pi-chrome`. Build and push it from the repository root with the checked-in Cloud Build file:

```bash
gcloud builds submit session-runner --config session-runner/cloudbuild.pi-chrome.yaml --project pi-agents-cloud
firebase deploy --only functions --project pi-agents-cloud
firebase deploy --only hosting --project pi-agents-cloud
```

Record the resulting Artifact Registry digest and verify the `pi-chrome` tag before deploying Hosting. Functions must deploy before Hosting so the API recognizes the catalog, capability metadata, reservation, and signed browser access fields. A canary must then exercise Chrome launch, authenticated noVNC, MCP/QA attachment, popup windows, persistence, shell coexistence, stop, and replacement launch; delete the canary sessions and workspace afterward.

Production Cloud Functions run as `mapache-api@pi-agents-cloud.iam.gserviceaccount.com`. Per-session Cloud Run services run as `mapache-runner@pi-agents-cloud.iam.gserviceaccount.com`. Do not use `mapache-session-runner@...`; that service account does not exist in the project. The API service account must have `roles/iam.serviceAccountUser` on the runner service account, `roles/eventarc.eventReceiver` on the project so Firestore-triggered 2nd-gen functions can receive events, and `roles/logging.viewer` so the authenticated session Logs modal can read the selected runner's Cloud Run entries. Restore the project-level bindings with:

Scheduled automation workspace buckets keep this same identity boundary. The
control plane, running as the mandated `mapache-api` identity, applies an
idempotent bucket-level `roles/storage.objectUser` binding for
`mapache-runner`; it never grants the runner project-wide storage access or
bucket administration. Before changing IAM, the backend verifies the explicit
project, bucket name, workspace/owner labels, uniform bucket-level access, and
public-access-prevention metadata. Existing unrelated IAM bindings are
preserved and stale-etag updates retry with a bounded compare-and-set loop.

One shared runner service identity can still read any other bucket to which
that identity has been granted. Per-workspace IAM is not advertised as a raw
GCS tenant sandbox; API and agent-tool ownership checks remain the enforced
workspace boundary. Use explicit project flags for any manual IAM inspection or
repair, for example `gcloud storage buckets get-iam-policy gs://BUCKET
--project=pi-agents-cloud`.

```bash
gcloud projects add-iam-policy-binding pi-agents-cloud \
  --member serviceAccount:mapache-api@pi-agents-cloud.iam.gserviceaccount.com \
  --role roles/eventarc.eventReceiver \
  --condition=None

gcloud projects add-iam-policy-binding pi-agents-cloud \
  --member serviceAccount:mapache-api@pi-agents-cloud.iam.gserviceaccount.com \
  --role roles/logging.viewer \
  --condition=None
```

`.github/workflows/runner-images.yml` detects changes affecting the sole `pi-chrome` image. Pull requests build revision-tagged canaries without moving the compatibility tag. Main pushes and explicitly authorized manual runs may publish the compatibility tag after the immutable revision tag succeeds. Immutable tags include the complete source commit, so a different commit cannot overwrite a prior revision tag.

The workflow publishes the immutable `pi-chrome-<source-commit>` tag and, when publishing is enabled, the `pi-chrome` compatibility tag. Keep this mapping in `scripts/runner-image-release.mjs` so a successful build cannot leave the compatibility tag pointing at an older runner revision.

Runner-image jobs submit Cloud Builds asynchronously and poll the Cloud Build API for an authoritative terminal status. They do not stream the default Cloud Build log bucket, so the GitHub Actions service identity needs build submission/status permissions but does not need log-object read access. A successful status gates digest lookup and compatibility-tag publication; failure, internal error, timeout, cancellation, expiration, or an unknown status fails the matrix job. Each successful job summary records the Cloud Build URL, immutable image tag, digest, and source revision.

GitHub Actions preview and production workflows install root, `community/`, `functions/`, and `session-runner/` dependencies, run the fast checks, build the app/community output, and deploy to Firebase. Production writes `functions/.env.pi-agents-cloud` before deploy with the expected service account params plus `QA_LOGIN_UID`, `QA_LOGIN_EMAIL`, `QA_LOGIN_DISPLAY_NAME`, `GOOGLE_OAUTH_CLIENT_ID`, and `GOOGLE_OAUTH_REDIRECT_URI` from GitHub Actions variables.

Browser QA login uses a Functions secret plus configured QA account params. Configure `QA_LOGIN_SECRET` as a Firebase Functions secret, and set `QA_LOGIN_UID`, `QA_LOGIN_EMAIL`, and optionally `QA_LOGIN_DISPLAY_NAME` for the deployed function. The QA account must also be present in `appConfig/access` when the app allowlist is enabled. The API service account needs `roles/firebaseauth.admin` so it can create or update the controlled QA Firebase Auth user before minting the custom token.

MCP management changes require both the Functions API revision and the `pi-chrome` runner revision. Functions owns the workspace MCP config API and passes `MCP_CONFIG` into Cloud Run. The runner image must be rebuilt when the baked `pi-mcp-adapter` install changes; existing Cloud Run sessions need restart or recreation before they receive updated MCP config or image contents.

Google Workspace MCP connectivity additionally requires the configured OAuth client ID/redirect URI and the `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_STATE_SECRET`, and `GOOGLE_OAUTH_ENCRYPTION_KEY` Functions secrets. Deploy the Functions API before testing OAuth or provisioning, then rebuild the affected runner image for runner status/archive changes. Existing sessions keep their previous environment until restart or recreation. The storage model, scope catalog, and rollback/revoke procedure are documented in [Google Workspace MCP connectivity](./google-workspace-connectivity.md).

Running-session Google token renewal also deploys the dedicated `googleMcpToken` Function. That Function must retain the OAuth client-secret and encryption-key bindings, while the runner receives only its URL, a safe connection ID, and the existing per-session shutdown credential. Rebuild `pi-chrome` after changing `session-runner/google-workspace-mcp/`. Restart or recreate existing sessions after the Functions and image rollout because old Cloud Run revisions do not contain the refresh URL or refreshed MCP wrapper.

Cloud Run create, update, and delete operations use a 480-second polling deadline by default, configurable with `CLOUD_RUN_OPERATION_TIMEOUT_MS`. The API and queued-provisioning Functions use 540-second request timeouts, leaving one minute for readiness reconciliation and Firestore updates. This window intentionally exceeds Cloud Run control-plane backoff intervals that can defer an operation retry for five minutes; a shorter poll can delete a viable service before Cloud Run performs that retry. When create polling genuinely times out, Functions reconciles an already-ready service before reporting failure; otherwise it requests service deletion so a healthy but inaccessible runner is not left orphaned. Provisioning failures always record a user-safe `lastError`.

Per-session Cloud Run service IDs are derived from the Firestore session ID as a stable hashed `session-` identifier shorter than Cloud Run's 50-character limit. The resolver preserves an existing valid service ID for updates and repairs legacy or overlong IDs during service recreation, so operation-based session document IDs cannot make provisioning fail at the Cloud Run create request.

Active session service templates set `minInstanceCount: 1` and `maxInstanceCount: 1`. Managed pi-web-ui services also set the Cloud Run v2 `template.containers[].resources.cpuIdle` field to `false`, keeping CPU available for browser-independent work. Their persisted `longRunning` policy is off by default: the idle reaper automatically pauses an eligible managed runtime unless the user explicitly enables Long-running, which bypasses automatic pause for background work. Workspace Pause remains available in either state. Historical unmarked sessions retain the existing idle reaper and template behavior but cannot be restarted or reprovisioned after the one-runner backend cutover. Managed restart and resize first request the runner's bounded quiesce/final-save acknowledgement, delete the old service, confirm deletion, and only then reserve a new runtime generation and create its replacement. A failed acknowledgement, uncertain deletion, or startup failure leaves safe recoverable metadata and does not start a successor. Deploy Functions before validating this behavior, and restart, resize, or recreate an older managed session because an existing Cloud Run template retains its previous scaling values. Runner bootstrap-failure reporting additionally requires rebuilt affected standard runner images; older revisions can still leave Firestore at `running` after a later instance-start failure.

The embedded pi-web-ui rollout is now the default for newly created supported workspaces: Functions writes the fixed `agentUiVersion` marker and forces every new session to the curated `pi-chrome` image, ignoring client image fields. The deployment-only `scripts/mark-agent-workspace.mjs --project=pi-agents-cloud --confirm-qa=pi-web-ui-v1 --uid=<owner-uid> --workspace-id=<qa-workspace-id>` helper remains only as a controlled, owner-verified migration/rollback procedure; it accepts no image or version input from the browser. Access responses omit `agentUrl` until all compatibility and generation checks pass. Keep historical HubSpot source metadata and legacy records recoverable; do not mass-convert them.

Provisioning is idempotent by operation ID. Session creation persists the operation and attempt metadata before queueing, and the Functions transaction claims each worker attempt before sending a Cloud Run create request. Retries with the same `operationId` converge on the same session and Cloud Run service; completed operations return the existing session. If Cloud Run reports that the fixed per-session service already exists, provisioning polls and adopts it only after it becomes ready instead of recording a false failure. Other failures retain a safe error plus a retryable flag for controlled retry paths. The deployed `provisionQueuedSession` Firestore trigger handles queued records outside the client request, so create-session callers should treat the returned session as in progress and follow its Firestore status changes. That trigger must bind the GitHub App ID/private-key secrets and Google OAuth client/state/encryption secrets because connected GitHub and Google Workspace provisioning resolves credentials outside the API function.

Workspace sync-writer ownership is also controlled by Functions transactions. The post-cutover session reservation admits one `pi-chrome` runner per workspace and persists its writer lease together with managed runtime generation state; stop, delete, worker/Cloud Run provisioning failure, and the `reconcileWorkspaceSyncWriters` scheduled function release or repair the lease. Deploy the scheduled function with the Functions revision so existing workspaces can recover from stale owners.

The runner's compatibility default for a missing `WORKSPACE_SYNC_ROLE` is `writer`, preserving upload behavior for existing services. New reader services receive the role from Functions and skip worktree/archive uploads and deletion reconciliation; they can still restore workspace state at startup and use explicit sync-down.

Running sessions also persist the immutable Cloud Run image digest. The `refreshRunnerImageFreshness` scheduled function compares that digest with the current Artifact Registry digest behind each curated image tag and records `latest`, `stale`, or `unknown` for the frontend. Artifact Registry lookup failures remain unknown and never claim that a session is current.

The HubSpot migration has one migration-specific export command at
`scripts/hubspot-pi-web-export.mjs`. It reads the restricted Task 1 inventory,
requires explicit owner/workspace/session IDs plus the exact source prefix and a
separate output prefix, and defaults to a no-write inspection plan. An execute
run additionally requires local materialized workspace and selected-session
roots plus a controller module implementing the actual source `quiesce()` and
`stop()` operations. The exporter refuses a non-quiescent proof, source/output
prefix or path collisions, an existing output directory, and source mapping
mismatches. It preserves hidden files, `.git`, binary bytes, selected-session
JSONL, and referenced readable attachments in a restricted checksummed backup;
Chrome profile state and other sessions are explicitly excluded. A trailing
incomplete JSONL record is preserved and flagged in the manifest. This command
is preparation for the later rehearsal/cutover tasks: do not run it against the
live HubSpot source during ordinary deployment work, and never write to the
source prefix.

The companion importer lives under `scripts/migrations/pi-web-ui-hubspot/`. It
requires a verified export plus explicit new owner/workspace/session IDs,
storage prefix, and separate target roots for `/workspace`, flat Pi sessions,
non-secret Pi config, and UI data. It rejects source/target identity or prefix
overlap, checksum/path/symlink failures, credentials, unsupported history, and
targets containing work. It stages the copy, validates discovery and opening
through the pinned Pi SDK's `SessionManager.listAll` and `SessionManager.open`,
then installs the fixed layout without starting an agent or model turn. The
only managed-config rewrite is in the copied settings file: conflicting
`pi-goal-x` package/launch declarations are removed and recorded in the
comparison report; the backup remains unchanged. Use `--verify-only` for
cutover or rollback evidence, and pass `--execute` only for an isolated target.

## Invariants

- Always pass `--project pi-agents-cloud` to remote Firebase/GCP commands.
- Keep Functions and runner service accounts separate.
- Functions changes require a Functions deploy before handoff unless the user explicitly asks not to deploy.
- Keep `CLOUD_RUN_OPERATION_TIMEOUT_MS` below the API Function timeout so timeout reconciliation and Firestore updates have time to complete.
- Share Preview, browser QA, and managed Agent runtime changes that touch `session-runner/` require rebuilding and pushing `pi-chrome`; existing sessions keep their current runner revision until restarted or recreated.
- Keep `QA_LOGIN_SECRET` out of source files, browser builds, logs, and checked-in QA artifacts.
- Runner image changes require a Cloud Build push; existing Cloud Run services keep their current image/revision until restarted, recreated, or updated.
- The `pi-chrome` image build validates `python3 --version`, and the runner unit suite keeps that Python 3 contract aligned with the Dockerfile.
- The supported runner image tag is `pi-chrome`; immutable release tags use `pi-chrome-<source-commit>`. Historical Artifact Registry tags and Cloud Run services are not purged by this cutover.
- Chrome image builds run the bounded `check-chrome-runtime.js` and `chrome-smoke.js` checks before publishing, but production canary verification is still required after Functions and Hosting deploy.
- Chrome desktop supervision changes require rebuilding and publishing `pi-chrome`; existing Cloud Run services retain their current runner revision until restarted or recreated. The runner gates dependent process launch on Xvfb readiness and requires CDP plus loopback VNC readiness before reporting a browser runtime as ready. No Functions or Hosting deployment is needed when the browser status/API contract is unchanged.
- Do not put developer maintenance notes under `community/`.

## Verification

- `npm run check`
- For deploy-sensitive changes, inspect the relevant GitHub Actions workflow.
- For Functions deploys, report the command and outcome.

## Last Verified Assumptions

- 2026-06-17: `firebase.json`, `.firebaserc`, and root package scripts match this page.

## Related Docs

- [Testing](./testing.md)
- [Runtime containers](./runtime-containers.md)
- [Backend API architecture](./backend-api-architecture.md)
- [Frontend/Functions/runner compatibility matrix](./guides/frontend-functions-runner-compatibility.md)

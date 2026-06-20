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

Firebase Hosting serves the Vite app from `dist/`, rewrites `/api/**` to the `api` Cloud Function, rewrites `/app` and `/app/**` to the app shell, and serves the Docusaurus community build under `/community/**`.

The `/api/**` rewrite also serves public shared website previews at `/api/public-previews/{token}/...`. Those requests are intentionally unauthenticated and are authorized by unguessable preview tokens plus `publicPreviews/{token}` metadata. Deploying Share Preview requires both the Cloud Functions API revision and the web-capable session runner image revision that includes `POST /preview/share`; existing running Cloud Run sessions need restart/recreation before they can export shared previews. Deploying browser QA contract changes likewise requires rebuilt `pi-web` and `codex-web` runner images; existing running web sessions keep the old browser QA command/status behavior until they are restarted or recreated.

The repo targets the `pi-agents-cloud` Firebase/GCP project. Use explicit project flags for remote build and deploy commands:

```bash
firebase deploy --only hosting --project pi-agents-cloud
firebase deploy --only functions --project pi-agents-cloud
gcloud builds submit session-runner --project pi-agents-cloud --tag us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:latest
```

Production Cloud Functions run as `mapache-api@pi-agents-cloud.iam.gserviceaccount.com`. Per-session Cloud Run services run as `mapache-runner@pi-agents-cloud.iam.gserviceaccount.com`. Do not use `mapache-session-runner@...`; that service account does not exist in the project. The API service account must have `roles/iam.serviceAccountUser` on the runner service account.

GitHub Actions preview and production workflows install root, `community/`, `functions/`, and `session-runner/` dependencies, run the fast checks, build the app/community output, and deploy to Firebase. Production writes `functions/.env.pi-agents-cloud` before deploy with the expected service account params plus `QA_LOGIN_UID`, `QA_LOGIN_EMAIL`, and `QA_LOGIN_DISPLAY_NAME` from GitHub production environment variables.

Browser QA login uses a Functions secret plus configured QA account params. Configure `QA_LOGIN_SECRET` as a Firebase Functions secret, and set `QA_LOGIN_UID`, `QA_LOGIN_EMAIL`, and optionally `QA_LOGIN_DISPLAY_NAME` for the deployed function. The QA account must also be present in `appConfig/access` when the app allowlist is enabled. The API service account needs `roles/firebaseauth.admin` so it can create or update the controlled QA Firebase Auth user before minting the custom token.

MCP management changes require both the Functions API revision and affected runner image revisions. Functions owns the workspace MCP config API and passes `MCP_CONFIG` into Cloud Run. Pi runner images must be rebuilt when the baked `pi-mcp-adapter` install changes; existing Pi and Codex Cloud Run sessions need restart or recreation before they receive updated MCP config or image contents.

## Invariants

- Always pass `--project pi-agents-cloud` to remote Firebase/GCP commands.
- Keep Functions and runner service accounts separate.
- Functions changes require a Functions deploy before handoff unless the user explicitly asks not to deploy.
- Share Preview and browser QA runtime changes that touch `session-runner/` require rebuilding and pushing `pi-web` and `codex-web`; existing web sessions keep their current runner revision until restarted or recreated.
- Keep `QA_LOGIN_SECRET` out of source files, browser builds, logs, and checked-in QA artifacts.
- Runner image changes require a Cloud Build push; existing Cloud Run services keep their current image/revision until restarted, recreated, or updated.
- Runner image tags currently include `latest`, `pi-basic`, `pi-web`, `pi-n64`, `codex-basic`, and `codex-web`.
- The Codex runner Dockerfiles pin Codex CLI `0.140.0` and install the published Linux package tarball directly because that release's `codex-package_SHA256SUMS` file is missing the Linux standalone package entry and breaks the hosted `install.sh` flow.
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

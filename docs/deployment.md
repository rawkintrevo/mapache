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

The repo targets the `pi-agents-cloud` Firebase/GCP project. Use explicit project flags for remote build and deploy commands:

```bash
firebase deploy --only hosting --project pi-agents-cloud
firebase deploy --only functions --project pi-agents-cloud
gcloud builds submit session-runner --project pi-agents-cloud --tag us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:latest
```

Production Cloud Functions run as `mapache-api@pi-agents-cloud.iam.gserviceaccount.com`. Per-session Cloud Run services run as `mapache-runner@pi-agents-cloud.iam.gserviceaccount.com`. Do not use `mapache-session-runner@...`; that service account does not exist in the project. The API service account must have `roles/iam.serviceAccountUser` on the runner service account.

GitHub Actions preview and production workflows install root, `community/`, `functions/`, and `session-runner/` dependencies, run the fast checks, build the app/community output, and deploy to Firebase. Production writes `functions/.env.pi-agents-cloud` with the expected service account params before deploy.

Browser QA login uses a Functions secret plus configured QA account params. Configure `QA_LOGIN_SECRET` as a Firebase Functions secret, and set `QA_LOGIN_UID`, `QA_LOGIN_EMAIL`, and optionally `QA_LOGIN_DISPLAY_NAME` for the deployed function. The QA account must also be present in `appConfig/access` when the app allowlist is enabled. The API service account needs `roles/firebaseauth.admin` so it can create or update the controlled QA Firebase Auth user before minting the custom token.

## Invariants

- Always pass `--project pi-agents-cloud` to remote Firebase/GCP commands.
- Keep Functions and runner service accounts separate.
- Functions changes require a Functions deploy before handoff unless the user explicitly asks not to deploy.
- Keep `QA_LOGIN_SECRET` out of source files, browser builds, logs, and checked-in QA artifacts.
- Runner image changes require a Cloud Build push; existing Cloud Run services keep their current image/revision until restarted, recreated, or updated.
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

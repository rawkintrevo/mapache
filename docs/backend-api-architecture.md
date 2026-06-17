# Backend API Architecture

## Purpose

This page owns the Cloud Functions API architecture and backend module boundaries.

## Read When

Read this before changing authenticated API routes, workspace/session lifecycle behavior, Firestore ownership, Cloud Run provisioning, GitHub/Pi proxy behavior, or user usage accounting.

## Canonical Owner

- Entrypoint: `functions/index.js`
- Route parsing and dispatch: `functions/apiRoutes.helpers.js`, `functions/apiDispatch.helpers.js`
- Backend setup/config: `functions/backendContext.js`, `functions/backendConfig.js`
- Shared validation/errors: `functions/backendUtils.helpers.js`
- Auth/profile: `functions/auth.service.js`
- Workspaces/files: `functions/workspace.service.js`
- Cloud Run sessions: `functions/cloudRun.service.js`
- GitHub App and PR flows: `functions/github.service.js`
- Pi auth, packages, and skills: `functions/pi.service.js`
- Usage rollups: `functions/userUsage.service.js`
- Runner image catalog: `functions/runnerImages.helpers.js`

## Current Behavior

The frontend calls authenticated JSON routes under `/api/**`. Cloud Functions verifies Firebase ID tokens, applies the optional `appConfig/access` allow list, upserts `users/{uid}`, then serves user-owned workspace and session data.

Workspace documents live at `workspaces/{workspaceId}` and carry `ownerUid`, `userPath`, source metadata, storage bucket, and storage prefix. Sessions live under `workspaces/{workspaceId}/sessions/{sessionId}` and repeat ownership metadata for explicit checks and operational queries.

Session creation writes a Firestore session record, resolves the curated runner image key server-side, provisions a per-session Cloud Run service, and records service URL/status/image/capability metadata. Session stop/delete paths clean up Cloud Run services and record allocated runner usage.

Backend proxy routes verify workspace/session ownership before calling protected runner routes for Git status/actions, Pi skills, Pi package operations, preview/access URLs, and auth materialization. Browser terminal/preview access uses finite-lifetime runner URLs signed with the per-session browser secret; backend-only runner management keeps using the shutdown token gate.

## Invariants

- Firebase Auth UID is the ownership boundary for workspace/session/user metadata.
- The backend, not the frontend, is authoritative for runner image selection and GitHub workspace concurrency guards.
- Cloud Functions and session runners use separate service accounts.
- Do not write secret values to Firestore, Cloud Storage, logs, workspace files, or browser state.
- Route handlers should remain small; move cohesive domain behavior into service/helper modules as areas are touched.

## Verification

- `npm --prefix functions test`
- `npm run docs:check` after docs edits.
- Deploy Functions with `firebase deploy --only functions --project pi-agents-cloud` when Functions code changes and deployment is required by repo instructions.

## Last Verified Assumptions

- 2026-06-17: Backend modules and tests listed above exist in `functions/`.

## Related Docs

- [App overview](./app-overview.md)
- [GitHub workspaces](./github-workspaces.md)
- [Pi skills manager](./pi-skills-manager.md)
- [Pi extension manager](./pi-extension-manager.md)
- [Deployment](./deployment.md)

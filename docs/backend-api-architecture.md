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
- Admin user listing and allowlist controls: `functions/admin.service.js`
- QA custom token login: `functions/qaAuth.service.js`
- Workspaces/files: `functions/workspace.service.js`
- Cloud Run sessions: `functions/cloudRun.service.js`
- GitHub App and PR flows: `functions/github.service.js`
- Pi auth, packages, and workspace skills: `functions/pi.service.js`
- Usage rollups: `functions/userUsage.service.js`
- Runner image catalog: `functions/runnerImages.helpers.js`

## Current Behavior

The frontend calls authenticated JSON routes under `/api/**`. Cloud Functions verifies Firebase ID tokens, applies the optional `appConfig/access` allow list, upserts `users/{uid}`, then serves user-owned workspace and session data. Users whose Firestore profile document has `isAdmin: true` can also call `/api/admin/users` to page through user summaries and `/api/admin/users/{uid}/whitelist` to toggle explicit allowlist entries for other users.

The exception is the QA custom-token route at `POST /api/qa/custom-token`. It is unauthenticated but gated by the `QA_LOGIN_SECRET` Functions secret and the configured QA UID/email parameters. It mints a Firebase custom token for a controlled QA account so browser automation can reach the signed-in app shell; all subsequent API calls still use normal Firebase ID-token verification and app allowlist checks.

Workspace documents live at `workspaces/{workspaceId}` and carry `ownerUid`, `userPath`, source metadata, storage bucket, and storage prefix. Sessions live under `workspaces/{workspaceId}/sessions/{sessionId}` and repeat ownership metadata for explicit checks and operational queries.

Session creation writes a Firestore session record, resolves the curated runner image key server-side, provisions a per-session Cloud Run service, and records service URL/status/image/capability metadata. The API function uses a longer request timeout than the default so slower runner image rollouts, especially Chromium-backed web images, can finish Cloud Run provisioning instead of timing out while the service is still becoming healthy. Session stop/delete paths clean up Cloud Run services and record allocated runner usage.

Admin user summaries reuse the same usage rollups as `/api/me`, but return cost estimates in dollars for lifetime and trailing-30-day windows. Whitelist toggles update `appConfig/access`, preferring `allowedEmails` when the target user has an email and `allowedUids` otherwise.

Backend proxy routes verify workspace/session ownership before calling protected runner routes for Git status/actions, workspace skills, Pi package operations, preview/access URLs, share-preview export, and auth materialization. Browser terminal/preview access uses finite-lifetime runner URLs signed with the per-session browser secret; backend-only runner management keeps using the shutdown token gate.

Workspace skills now use neutral session routes at `/api/workspaces/{workspaceId}/sessions/{sessionId}/skills` and `/skills/delete`. `functions/pi.service.js` still owns validation and compatibility because Pi and Codex share the same name/description/content rules and the same rollout path. The service gates skill management to Pi and Codex sessions, prefers the neutral runner `/skills*` endpoints, and falls back to legacy `/pi/skills*` routes when an older runner revision is still serving an existing session.

Website sessions with preview capability can create a public share preview through `POST /api/workspaces/{workspaceId}/sessions/{sessionId}/share-preview`. The API verifies workspace/session ownership, requires a running preview-capable session, generates an unguessable token, asks the runner to upload only the configured static preview root, and stores metadata in `publicPreviews/{token}`. Public reads use unauthenticated `GET /api/public-previews/{token}/...`, which serves objects from the recorded Cloud Storage prefix with SPA fallback to `index.html`. These public routes do not expose source files, session runner URLs, browser-access tokens, shutdown tokens, environment variables, or workspace storage prefixes.

GitHub connector account routes live under `/api/github/**` and are implemented in `functions/github.service.js`. `GET /api/github/connection` returns safe connection metadata from `githubUsers/{uid}` and installation docs without token material. `GET /api/github/repos` refreshes the connected repository view through short-lived installation tokens. `POST /api/github/disconnect` performs a soft disconnect by marking the user connection disconnected and installation docs removed; it does not delete workspace source metadata or revoke/delete any secret material.

## Invariants

- Firebase Auth UID is the ownership boundary for workspace/session/user metadata.
- Admin-only API routes must require `users/{uid}.isAdmin === true`; being on the app allowlist is not enough to enumerate users or edit allowlist state.
- The backend, not the frontend, is authoritative for runner image selection and GitHub workspace concurrency guards.
- Cloud Functions and session runners use separate service accounts.
- Do not write secret values to Firestore, Cloud Storage, logs, workspace files, or browser state.
- Public preview documents may identify owner/workspace/session ids for maintenance, but public preview responses must only serve files copied from the static preview output prefix.
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

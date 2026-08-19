# Backend API Architecture

## Purpose

This page owns the Cloud Functions API architecture and backend module boundaries.

## Read When

Read this before changing authenticated API routes, workspace/session lifecycle behavior, Firestore ownership, Cloud Run provisioning, GitHub/Pi proxy behavior, or user usage accounting.

## Canonical Owner

- Entrypoint: `functions/index.js`
- Route contract, parsing, and dispatch: `functions/apiRouteManifest.js`, `functions/apiRoutes.helpers.js`, `functions/apiDispatch.helpers.js`
- Production handler registry: `functions/apiHandlers.helpers.js`, composed by `functions/index.js`
- Backend setup/config: `functions/backendContext.js`, `functions/backendConfig.js`
- Shared validation/errors: `functions/backendUtils.helpers.js`
- Auth/profile: `functions/auth.service.js`
- Admin user listing and allowlist controls: `functions/admin.service.js`
- QA custom token login: `functions/qaAuth.service.js`
- Workspaces/files: `functions/workspace.service.js`, with live runner materialization coordinated by `functions/index.js`
- Cloud Run sessions: `functions/cloudRun.service.js`
- Session creation and persisted session metadata: `functions/sessionCreation.service.js`
- Session mutation, lookup, stop/reap transitions, and lifecycle bookkeeping: `functions/sessionLifecycle.service.js`
- Preview publication, public serving, and signed session access URLs: `functions/preview.service.js`
- SSH session file and port-forward proxies: `functions/sshSession.service.js`
- Git session status/action/PR proxies: `functions/gitSession.service.js`
- GitHub App and PR flows: `functions/github.service.js`
- Generic environment-key storage, redaction, CRUD, and runner resolution: `functions/environmentKeys.service.js`
- Agent credential storage, compatibility reads/writes, selection, and materialization: `functions/agentAuth.service.js`
- OpenAI Codex device-code/OAuth flow and token normalization: `functions/openAiCodexAuth.service.js`
- Pi package proxies, source parsing, and observed catalog: `functions/piPackages.service.js`
- Workspace skills and workspace subagents: `functions/pi.service.js`
- Runner harness catalog: `functions/runnerCatalog.helpers.js`, `functions/runnerImages.helpers.js`
- Session resource catalog and validation: `functions/sessionResourceCatalog.json`, `functions/sessionResources.helpers.js`
- Usage rollups: `functions/userUsage.service.js`

## Current Behavior

The frontend calls authenticated JSON routes under `/api/**`. Cloud Functions verifies Firebase ID tokens, applies the optional `appConfig/access` allow list, upserts `users/{uid}`, then serves user-owned workspace and session data. Users whose Firestore profile document has `isAdmin: true` can also call `/api/admin/users` to page through user summaries and `/api/admin/users/{uid}/whitelist` to toggle explicit allowlist entries for other users. The route method manifest is shared by route validation and dispatch lookup, while `createApiHandlers` assembles the production registry in a Firebase-free helper so contract tests can enumerate every dispatcher dependency without starting the Functions runtime.

The exception is the QA custom-token route at `POST /api/qa/custom-token`. It is unauthenticated but gated by the `QA_LOGIN_SECRET` Functions secret and the configured QA UID/email parameters. It mints a Firebase custom token for a controlled QA account so browser automation can reach the signed-in app shell; all subsequent API calls still use normal Firebase ID-token verification and app allowlist checks.

Workspace documents live at `workspaces/{workspaceId}` and carry `ownerUid`, `userPath`, source metadata, storage bucket, storage prefix, and workspace-scoped MCP server config. Sessions live under `workspaces/{workspaceId}/sessions/{sessionId}` and repeat ownership metadata for explicit checks and operational queries.

File browser writes use Cloud Storage as the workspace source of truth. After a web upload or editor save, the frontend calls `POST /api/workspaces/{workspaceId}/sync-files`; Functions verifies workspace ownership, finds running cloud sessions for that workspace, and asks each runner to pull current storage into its live `/workspace` directory. The sync request is best-effort per session so a storage write does not fail solely because one active runner is temporarily unavailable.

Session creation writes a Firestore session record with a queued provisioning state, resolves the curated runner image key and `harnessId` server-side, snapshots the selected workspace's MCP config into the session, validates and normalizes CPU/memory through `functions/sessionResources.helpers.js`, reserves the workspace sync-writer role in the same transaction, and returns before Cloud Run readiness. A provisionable non-SSH session is the writer when no active writer exists; additional eligible sessions receive `syncWriterRole: "reader"` and remain usable. SSH and unavailable-image sessions receive `syncWriterRole: "none"`. The workspace stores `syncWriterSessionId`, `syncWriterLeaseId`, and `syncWriterLeaseUpdatedAt`; stop, delete, provisioning failure, and the five-minute reconciliation job release or repair stale ownership transactionally. The `provisionQueuedSession` Firestore trigger provisions a per-session Cloud Run service and records service URL/status/image/capability metadata. Cloud requests that omit both resource fields use the catalog's Small mapping unless an explicit `SESSION_CPU`/`SESSION_MEMORY` operator override is configured; SSH creation retains the configured legacy default. Partial payloads, unknown CPU/memory values, and unsupported Cloud Run pairs return HTTP 400 with the stable `invalid_session_resources` error before any Firestore or Cloud Run mutation. A client-provided size key is presentation metadata only and is ignored by provisioning. Chrome-capable creation is guarded by a Firestore transaction over the workspace and child sessions: a workspace may have one active Chrome session, while shell and other non-Chrome sessions remain allowed. A failed Chrome reservation or worker/Cloud Run create releases the reservation. Restart can replace the existing Chrome session only when it is the same reserved session. Restart refreshes the MCP snapshot from the workspace before patching or recreating Cloud Run so active sessions can pick up right-drawer MCP edits. The API function uses a longer request timeout than the default so slower runner image rollouts, especially Chromium-backed web images, can finish Cloud Run provisioning instead of timing out while the service is still becoming healthy. Session stop/delete paths clean up Cloud Run services and record allocated runner usage.

SSH-backed sessions use the same session collection and Cloud Run provisioning path, but set `sessionType: "ssh"` and `terminalKind: "ssh"` so the runner opens an SSH client PTY instead of a local harness. Dev machine workspaces store public SSH target metadata on the workspace source and store private key plus optional certificate material under the owner's private user subcollection. Session creation for those workspaces loads the private material server-side and passes it only as provisioning environment for the runner revision. Session-scoped SSH file routes and port-forward routes verify normal workspace/session ownership before proxying to backend-only runner routes.

Admin user summaries reuse the same usage rollups as `/api/me`, but return cost estimates in dollars for lifetime and trailing-30-day windows. Whitelist toggles update `appConfig/access`, preferring `allowedEmails` when the target user has an email and `allowedUids` otherwise.

Backend proxy routes verify workspace/session ownership before calling protected runner routes for Git status/actions, workspace skills, workspace subagents, Pi package operations, preview/access URLs, share-preview export, and auth materialization. `createSessionAccessUrls` also returns short-lived signed `browserUrl` and `browserStatusUrl` values for Chrome-capable sessions. The runner serves `/browser/` and `/browser/status` only after validating the HMAC token bound to the session; its `/browser/vnc` WebSocket bridge reaches loopback-only x11vnc, and `/browser/activity` accepts either the browser token or the backend runner token. Raw CDP/VNC ports and the profile archive remain container-internal. Browser terminal/preview access uses finite-lifetime runner URLs signed with the per-session browser secret; backend-only runner management keeps using the shutdown token gate.

Workspace MCP management routes live at `GET/PUT /api/workspaces/{workspaceId}/mcp`. The backend validates server names, stdio command/args, URL transports, env maps, and headers, then stores a normalized `{version, mcpServers}` config on the workspace document. Secrets should be referenced through environment variables rather than written directly into MCP config.

Generic environment keys use the private `users/{uid}/private/environmentKeys/entries/{entryId}` collection. `GET/POST /api/auth/environment` and `PUT/DELETE /api/auth/environment/{entryId}` enforce the authenticated UID boundary, validate shell-safe names, reject runner-managed names, and never return the stored value. Workspace and session documents store only selected entry IDs in the canonical `environmentEntryIds` field; Cloud Run provisioning resolves those IDs server-side and adds the values to the new revision environment. Sessions created during the initial rollout may carry `genericEnvironmentEntryIds`, which provisioning and restart treat as a compatibility fallback until the canonical field is written. An explicit empty ID list removes all generic keys from a session, including shell sessions, and missing IDs left by deleted keys are ignored during provisioning. Existing runners require restart or reprovisioning after a selection or value change.

Workspace auth now uses neutral account routes at `/api/auth/*` plus the per-session route `POST /api/workspaces/{workspaceId}/sessions/{sessionId}/auth-selection`. Saved credentials persist in `users/{uid}/private/agentAuth`, but the backend still reads and mirrors writes to legacy `users/{uid}/private/piAuth` during rollout compatibility. Session selection persists in `authSelection` on the session document, and backend writes still mirror the provider map to legacy `piAuthSelection` so older Pi sessions continue to materialize the intended credentials until the compatibility layer is removed. Legacy `/api/pi-auth/*` and `/api/.../pi-auth-selection` aliases remain available for rollout compatibility.

Workspace skills now use neutral session routes at `/api/workspaces/{workspaceId}/sessions/{sessionId}/skills` and `/skills/delete`. `functions/pi.service.js` still owns validation and compatibility because Pi and Codex share the same name/description/content rules and the same rollout path. The service gates skill management to Pi and Codex sessions, prefers the neutral runner `/skills*` endpoints, and falls back to legacy `/pi/skills*` routes when an older runner revision is still serving an existing session.

Workspace subagents use parallel neutral session routes at `/api/workspaces/{workspaceId}/sessions/{sessionId}/subagents` and `/subagents/delete`. The backend gates subagent CRUD to Pi and Codex sessions, validates the shared name/description/instructions rules, and proxies to runner-managed native files. The runner may expose `/subagent-chains` for future internal work, but the Functions API does not advertise or dispatch chain routes in V1.

Website sessions with preview capability can create a public share preview through `POST /api/workspaces/{workspaceId}/sessions/{sessionId}/share-preview`. The API verifies workspace/session ownership, requires a running preview-capable session, generates an unguessable token, asks the runner to upload only the configured static preview root, and stores metadata in `publicPreviews/{token}`. Public reads use unauthenticated `GET /api/public-previews/{token}/...`, which serves objects from the recorded Cloud Storage prefix with SPA fallback to `index.html`. These public routes do not expose source files, session runner URLs, browser-access tokens, shutdown tokens, environment variables, or workspace storage prefixes.

GitHub connector account routes live under `/api/github/**` and are implemented in `functions/github.service.js`. `GET /api/github/connection` returns safe connection metadata from `githubUsers/{uid}` and installation docs without token material. `GET /api/github/repos` refreshes the connected repository view through short-lived installation tokens. `POST /api/github/disconnect` performs a soft disconnect by marking the user connection disconnected and installation docs removed; it does not delete workspace source metadata or revoke/delete any secret material.

## Invariants

- Firebase Auth UID is the ownership boundary for workspace/session/user metadata.
- Admin-only API routes must require `users/{uid}.isAdmin === true`; being on the app allowlist is not enough to enumerate users or edit allowlist state.
- The backend, not the frontend, is authoritative for runner image selection and GitHub workspace concurrency guards.
- CPU and memory are the canonical persisted/provisioned resource fields. The resource catalog owns supported advanced values, preset mappings, Cloud Run pair constraints, and the us-central1 estimate formula; size labels are never required for compatibility.
- Resize accrues usage before changing validated resources, and failed resource validation must not change usage counters, `resizing`, or Cloud Run state.
- Chrome ownership is transactional and is released on stop, delete, and provisioning failure; stale reservations are reconciled before a replacement launch.
- Cloud Functions and session runners use separate service accounts.
- Do not write secret values to public workspace/session documents, Cloud Storage, logs, workspace files, or browser state. Credential material that must persist should stay in owner-scoped private user documents and only be materialized into runner environment when needed.
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
- [Runner harnesses](./runner-harnesses.md)
- [Pi skills manager](./pi-skills-manager.md)
- [Pi extension manager](./pi-extension-manager.md)
- [Deployment](./deployment.md)
- [Session lifecycle](./guides/session-lifecycle.md)
- [SSH-backed sessions guide](./guides/ssh-backed-sessions.md)

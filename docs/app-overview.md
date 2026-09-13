# App Overview

## Purpose

This page gives a concise product and system overview for Mapache Tools. Use focused subsystem pages for implementation details.

## Read When

Read this before changing workspace/session workflow, authenticated app shape, source-of-truth assumptions, or cross-subsystem behavior.

## Product Shape

Mapache Tools is a Firebase and Cloud Run app for browser-managed cloud runner sessions. Authenticated users create workspaces, start isolated Cloud Run `pi-chrome` runner sessions, and work from the signed-in workspace shell. New server-marked workspaces open the embedded Agent surface first; historical unmarked sessions remain terminal-first for compatibility. The public landing page is served from `/`; the authenticated workspace shell is served from `/app` and `/app/**`; the Docusaurus community site remains under `/community/**`.

The selected-workspace view is Agent-first for the workspace's canonical marked runtime. Agent, `Persistent Chrome`, and Logs are peer controls in the left toolbar; Logs opens the runtime log modal, while the center is reserved for the borderless embedded Agent canvas. Preview is not a workspace navigation surface. The workspace is either on or off; Play/Pause in the top navigation controls that runtime. Historical sessions remain readable with their retained terminal/shell/SSH compatibility surfaces, but the parent shell no longer duplicates upstream files, Git, models, skills, extensions, subagents, Chat, or Goals. The left drawer remains collapsed by default. The top navigation opens Mapache-owned authentication, generic-environment, MCP, and Google Workspace dialogs; the shell has no right inspector drawer, while the embedded app owns agent settings.

Admin users are identified by `isAdmin: true` on their `users/{uid}` Firestore document. They get an Admin page from the left drawer user menu for paginated user visibility, allowlist toggles, and per-user runner cost summaries.

## Workspace Modes

Blank workspaces use Cloud Storage as durable workspace state. GitHub workspaces use GitHub as durable repository state and Cloud Storage as a resumability/cache layer. Workspace source metadata is explicit: blank workspaces use `source: {type: "blank"}`, and GitHub workspaces store normalized repository metadata and optional GitHub App connection metadata.

The detailed model for GitHub-backed workspaces lives in [github-workspaces.md](./github-workspaces.md).

## Major Components

- Firebase Hosting serves the Vite frontend from `dist/`.
- Firebase Auth handles Google sign-in.
- Cloud Functions exposes `/api/**` for workspace/session lifecycle, signed access, credentials, MCP/Google connections, GitHub connections, and QA controls.
- Firestore stores user profiles, workspaces, sessions, usage ledgers, GitHub connection metadata, and versioned runtime pointers.
- Cloud Storage stores blank workspace files, cached GitHub worktrees, and archive-backed runtime state.
- Cloud Run runs per-session terminal containers from curated runner images.

## Ownership Model

Firebase Auth UID is the user ownership boundary. Backend routes verify the Firebase ID token, apply the optional Firestore allow list at `appConfig/access`, upsert `users/{uid}`, then serve only workspaces and sessions whose `ownerUid` matches that UID. Firestore rules mirror this boundary for direct client reads.

Workspaces live at `workspaces/{workspaceId}` and store workspace-level runtime resources plus a lazily adopted `canonicalSessionId`. Runtime records remain under `workspaces/{workspaceId}/sessions/{sessionId}` so Cloud Run identity, checkpoints, access, and usage remain stable. Session stop/delete paths clean up Cloud Run services and record allocated usage under `users/{uid}/sessionUsage/{sessionId}`.

## Frontend Summary

The frontend uses React on Vite. `src/main.js` initializes Firebase/Auth, owns app state and orchestration, and renders `src/App.jsx`. React UI lives under `src/components/`; controllers live under `src/controllers/`; API/state workflows live under `src/workflows/`; API client calls live in `src/services/api.js`.

Global user actions run through the central `state.busy` guard in `src/main.js`, which keeps overlapping mutations disabled. The signed-in shell surfaces that state with `src/components/layout/GlobalActionIndicator.jsx`, using `state.busyMessage` when a specific action label is available and `Working...` otherwise.

Read [frontend-architecture.md](./frontend-architecture.md), [ui-components.md](./ui-components.md), and [css-decomposition.md](./css-decomposition.md) before changing frontend ownership, components, or styling.

## Backend Summary

`functions/index.js` is the Cloud Functions entrypoint. Route parsing and grouped dispatch live in helper modules, while domain behavior lives in focused services for auth, workspaces, Cloud Run, GitHub, Pi, usage, runner images, and shared validation.

Read [backend-api-architecture.md](./backend-api-architecture.md) before changing API routes or backend ownership boundaries.

## Runtime Summary

Runner containers serve the upstream Agent gateway, terminal/shell, Preview, Chrome, metrics, workspace restore/sync, and runtime capability surfaces. The backend is authoritative for image selection and provisions per-session Cloud Run services with separate browser-access and backend-management tokens.

Read [runtime-containers.md](./runtime-containers.md) and [session-runner-architecture.md](./session-runner-architecture.md) before changing runtime images, PTY/WebSocket behavior, preview behavior, or sync.

## Current Design Decisions

- Start and pause the workspace's canonical runtime from the topbar Play/Pause control; the backend creates the first session on demand and retains session-addressed APIs for runtime plumbing.
- Keep the embedded Agent content first for new marked sessions; keep active terminal content first for historical unmarked sessions.
- Treat runner capabilities as explicit image/session metadata.
- Use Cloud Run per session for isolation and resource control.
- Treat workspace source mode as an explicit domain concept.
- Treat the workspace's `canonicalSessionId` as the only user-visible runtime. Existing workspaces adopt an active session first, otherwise the most recently updated session, without requiring a data migration.
- Enforce one active Pi/agent runtime per workspace; the embedded pi-web-ui owns conversations and any internal session concepts.
- Keep the Chrome profile in the workspace-owned internal archive path and never expose that archive, raw CDP, or VNC directly to users.
- Keep upstream skills and extensions configurable inside the upstream Agent/terminal; seed only Mapache-owned runtime guidance when needed.
- Do not expose duplicate parent file/Git or agent-setting controls for any session. Native Goals and conversation controls belong upstream.
- Keep developer knowledge in `docs/` and user-facing community content in `community/`.

## Related Docs

- [Subsystem map](./subsystem-map.md)
- [Frontend architecture](./frontend-architecture.md)
- [Backend API architecture](./backend-api-architecture.md)
- [Runtime containers](./runtime-containers.md)
- [Deployment](./deployment.md)
- [Testing](./testing.md)

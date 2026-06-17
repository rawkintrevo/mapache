# App Overview

## Purpose

This page gives a concise product and system overview for Mapache Tools. Use focused subsystem pages for implementation details.

## Read When

Read this before changing workspace/session workflow, authenticated app shape, source-of-truth assumptions, or cross-subsystem behavior.

## Product Shape

Mapache Tools is a Firebase and Cloud Run app for browser-managed cloud terminal sessions. Authenticated users create workspaces, start isolated Cloud Run runner sessions, and work from a terminal-first browser UI. The public landing page is served from `/`; the authenticated workspace shell is served from `/app` and `/app/**`; the Docusaurus community site remains under `/community/**`.

The selected-session view prioritizes the terminal. Web-capable sessions expose a `Preview` canvas beside the terminal. GitHub-backed sessions expose Git status, pull, stage/unstage, commit, push, and pull-request actions under the terminal controls. The left drawer owns workspace, file, and session navigation. The right drawer owns contextual tools: Authentication Center, Skills, and Extensions.

## Workspace Modes

Blank workspaces use Cloud Storage as durable workspace state. GitHub workspaces use GitHub as durable repository state and Cloud Storage as a resumability/cache layer. Workspace source metadata is explicit: blank workspaces use `source: {type: "blank"}`, and GitHub workspaces store normalized repository metadata and optional GitHub App connection metadata.

The detailed model for GitHub-backed workspaces lives in [github-workspaces.md](./github-workspaces.md).

## Major Components

- Firebase Hosting serves the Vite frontend from `dist/`.
- Firebase Auth handles Google sign-in.
- Cloud Functions exposes `/api/**` for workspace, session, GitHub, Pi auth, skills, and package operations.
- Firestore stores user profiles, workspaces, sessions, usage ledgers, GitHub connection metadata, and Pi package catalog metadata.
- Cloud Storage stores blank workspace files, cached GitHub worktrees, and archive-backed runtime state.
- Cloud Run runs per-session terminal containers from curated runner images.

## Ownership Model

Firebase Auth UID is the user ownership boundary. Backend routes verify the Firebase ID token, apply the optional Firestore allow list at `appConfig/access`, upsert `users/{uid}`, then serve only workspaces and sessions whose `ownerUid` matches that UID. Firestore rules mirror this boundary for direct client reads.

Workspaces live at `workspaces/{workspaceId}`. Sessions live under `workspaces/{workspaceId}/sessions/{sessionId}`. Session stop/delete paths clean up Cloud Run services and record allocated usage under `users/{uid}/sessionUsage/{sessionId}`.

## Frontend Summary

The frontend uses React on Vite. `src/main.js` initializes Firebase/Auth, owns app state and orchestration, and renders `src/App.jsx`. React UI lives under `src/components/`; controllers live under `src/controllers/`; API/state workflows live under `src/workflows/`; API client calls live in `src/services/api.js`.

Read [frontend-architecture.md](./frontend-architecture.md), [ui-components.md](./ui-components.md), and [css-decomposition.md](./css-decomposition.md) before changing frontend ownership, components, or styling.

## Backend Summary

`functions/index.js` is the Cloud Functions entrypoint. Route parsing and grouped dispatch live in helper modules, while domain behavior lives in focused services for auth, workspaces, Cloud Run, GitHub, Pi, usage, runner images, and shared validation.

Read [backend-api-architecture.md](./backend-api-architecture.md) before changing API routes or backend ownership boundaries.

## Runtime Summary

Runner containers serve the terminal, preview, protected Git/Pi endpoints, workspace restore/sync, and runtime capability surfaces. The backend is authoritative for image selection and provisions per-session Cloud Run services with separate browser-access and backend-management tokens.

Read [runtime-containers.md](./runtime-containers.md) and [session-runner-architecture.md](./session-runner-architecture.md) before changing runtime images, PTY/WebSocket behavior, preview behavior, or sync.

## Current Design Decisions

- Keep session creation in a modal launched from the workspace/sidebar context.
- Keep active terminal content first when a session is selected.
- Treat runner capabilities as explicit image/session metadata.
- Use Cloud Run per session for isolation and resource control.
- Treat workspace source mode as an explicit domain concept.
- Enforce one active Pi/agent session at a time for GitHub workspaces; shell sessions may run alongside for manual inspection.
- Keep Pi skills and package management additive to Pi terminal tooling by reading/writing the same workspace-local files.
- Keep developer knowledge in `docs/` and user-facing community content in `community/`.

## Related Docs

- [Subsystem map](./subsystem-map.md)
- [Frontend architecture](./frontend-architecture.md)
- [Backend API architecture](./backend-api-architecture.md)
- [Runtime containers](./runtime-containers.md)
- [Deployment](./deployment.md)
- [Testing](./testing.md)

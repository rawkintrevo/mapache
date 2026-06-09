# App Overview

Pi Agents Cloud is a Firebase and Cloud Run app for browser-managed cloud terminal sessions.

## Product Shape

The app lets an authenticated user create workspaces and run terminal sessions inside Cloud Run containers. The frontend is intentionally operational rather than marketing-oriented: after sign-in, users manage workspaces, sessions, and the active browser terminal.

The current selected-session experience prioritizes the terminal. When a session is selected, the main workspace panel renders the terminal first and does not show workspace setup content above it. Session creation is available from the selected workspace row in the sidebar through a circular `+` action.

## Main Components

- Firebase Hosting serves the Vite frontend from `dist/`.
- Firebase Auth handles Google sign-in.
- Cloud Functions exposes `/api/**` for workspace and session management.
- Firestore stores workspace records, session records, and terminal history.
- Cloud Run runs per-session terminal containers from the configured runner image.
- Cloud Storage syncs workspace files to and from each session container's `/workspace` directory.

## Frontend Structure

The frontend entrypoint is `src/main.js`. It owns app state, authentication wiring, API calls, selected workspace/session state, and modal state.

Rendering lives in `src/ui/render.js`. It uses small DOM helpers from `src/ui/utils.js` rather than a component framework. The UI is rebuilt from state on each render. This keeps the current app small and explicit, but means interactive state that should survive a render must live in `src/main.js`.

Styling lives in `src/styles.css`. The interface uses restrained operational styling: dense sidebar lists, compact controls, 8px-or-less radii for panels/cards, and a terminal-first selected-session view.

Session image choices live in `src/config/sessionImages.js`. This is the frontend source of truth for the container image dropdown in the create-session modal.

## Backend Flow

The frontend calls `src/services/api.js`, which sends authenticated JSON requests to `/api/**`.

`functions/index.js` handles workspace/session operations. Creating a session writes the session document, then provisions a Cloud Run service for that session when an image is available. Session records include the Cloud Run service name, public URL, selected image, resource limits, and workspace storage prefix.

The backend already accepts `payload.image` for session creation. If no image is passed, it falls back to `SESSION_RUNNER_IMAGE`.

## Current Design Decisions

- Keep session creation in a modal launched from the workspace sidebar, not as an always-visible form in the main workspace area.
- Keep the active terminal as the top content when a session is selected.
- Store container image choices in a config file so the UI can grow from one image to several without changing form code.
- Use Cloud Run per session. This isolates terminals and lets each session carry its own resource settings and image.
- Use Firebase Hosting rewrites for `/api/**`, so the deployed frontend can call the API without hard-coding Cloud Function URLs.

## Deployment

Frontend changes are deployed with:

```bash
firebase deploy --only hosting --project pi-agents-cloud
```

Runner container changes require a Cloud Build push and then a Cloud Run service update for existing sessions. New sessions use whatever image the create-session flow passes or the backend default.

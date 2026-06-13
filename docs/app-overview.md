# App Overview

Mapache Tools is a Firebase and Cloud Run app for browser-managed cloud terminal sessions.

## Product Shape

The app lets an authenticated user create workspaces and run terminal sessions inside Cloud Run containers. The frontend is intentionally operational rather than marketing-oriented: after sign-in, users manage workspaces, sessions, and the active browser terminal.

The public landing page is served from `/` by `LandingPageScreen`. It is a five-section, snap-scroll product page covering zero-config agent setup, workspace isolation, Cloud Run session architecture, the WebUI authentication center, and transparent usage/cost tracking. The primary Google sign-up CTA uses Firebase sign-in and then navigates to `/app`; secondary docs/blog CTAs point into the Docusaurus community site under `/community/**`. The authenticated workspace shell is served from `/app` and `/app/**`. Firebase Hosting still serves the Docusaurus community site separately under `/community/**`.

The current selected-session experience prioritizes the terminal. When a session is selected, the main workspace panel renders the terminal first and does not show workspace setup content above it. Web-capable sessions also expose a `Preview` canvas beside the terminal canvas; basic sessions do not show that UI. Navigation lives in a collapsible drawer with individually collapsible Workspaces, Files, and Sessions sections, plus a pinned bottom user avatar menu for opening the profile page, refreshing, and signing out. The right-side drawer now holds individually collapsible placeholder sections `Authentication Center`, `Skills`, and `Extensions` so future contextual tools can live beside the terminal without taking over the main workspace area. On desktop, the app shell is viewport-height and the left drawer content, main workspace area, and right drawer scroll independently so long drawer content does not lengthen the whole page. Session creation is available from the active workspace row or from the Sessions section action in the drawer.

The app now has an explicit architectural split between blank workspaces and GitHub-backed workspaces. Blank workspaces continue to treat Cloud Storage as their durable source of truth. GitHub workspaces treat GitHub as durable and use Cloud Storage as a resumability/cache layer. The detailed design lives in [github-workspaces.md](./github-workspaces.md).

The Pi skills manager uses the right-side `Skills` drawer as an additive web surface over Pi's documented skill discovery. Workspace-local skills are Markdown files under `/workspace/.pi/skills/{skill-name}/SKILL.md`; no separate plugin registration is required. The `pi-web` runner seeds default preview/API/QA skills into that same workspace-local skill tree when they are missing. The detailed design lives in [pi-skills-manager.md](./pi-skills-manager.md).

The planned Pi extension manager will use the right-side `Extensions` drawer as an additive web surface over Pi's existing package tooling. Workspace-local packages are the default: package declarations live in `/workspace/.pi/settings.json`, installed package code is runtime cache state, and packages installed from inside Pi with `pi install -l ...` should appear in the web UI after refresh. The detailed design lives in [pi-extension-manager.md](./pi-extension-manager.md).

## Main Components

- Firebase Hosting serves the Vite frontend from `dist/`.
- Firebase Auth handles Google sign-in.
- Cloud Functions exposes `/api/**` for workspace and session management.
- Firestore stores workspace records, session records, and terminal history.
- Firestore also stores user-scoped app metadata such as the planned Pi package catalog, which remembers packages a user has used across workspaces without installing them everywhere.
- Cloud Run runs per-session terminal containers from the configured runner image.
- Cloud Storage syncs workspace files to and from each session container's `/workspace` directory.

## Firestore Ownership Model

Firebase Auth is the source of user identity. On authenticated API requests, `functions/index.js` verifies the Firebase ID token and upserts a profile document at `users/{uid}` before serving workspace/session data.

User documents have this shape:

```js
{
  uid: "firebase-auth-uid",
  email: "user@example.com",
  displayName: "User Name",
  photoURL: "https://...",
  providerIds: ["google.com"],
  createdAt: Timestamp,
  lastSignedInAt: Timestamp,
  updatedAt: Timestamp
}
```

Workspaces are top-level documents in `workspaces/{workspaceId}` with `ownerUid` set to the authenticated user's UID and `userPath` set to `users/{uid}`. They also carry source metadata that distinguishes `blank` from `github` workspaces. Sessions are stored under `workspaces/{workspaceId}/sessions/{sessionId}` and carry the same `ownerUid`, `userPath`, and `workspaceId` for explicit ownership and operational queries.

The profile API also returns allocated runner usage for the authenticated user. Completed session intervals are recorded under `users/{uid}/sessionUsage/{sessionId}` when a session is stopped or deleted, and `/api/me` combines those records with any currently running or older unaccounted session documents. These numbers are derived from session runtime multiplied by configured Cloud Run CPU and memory limits; they are product usage counters, not Cloud Billing export or actual Cloud Monitoring CPU utilization.

The planned Pi package catalog is user-scoped under `users/{uid}`. It records package sources a user has installed or observed across workspaces so the Extensions panel can offer known packages for installation into the current workspace. The catalog stores metadata only; package code remains in runner workspace state and Cloud Storage archives.

Users can only see workspaces where `ownerUid` matches their Firebase Auth UID. Session list, resize, restart, stop, and delete operations first require ownership of the parent workspace, then operate only on that workspace's session subcollection. Firestore rules mirror this ownership boundary for direct client reads.

## Frontend Structure

The frontend now uses React on top of Vite. The entrypoint is `src/main.js`, which initializes Firebase/Auth, owns the current app state and handlers, and renders `src/App.jsx` through `react-dom/client`.

React UI is organized under `src/components/` with one component per file where practical. `src/App.jsx` selects between the React auth screen, fatal error screen, and the signed-in workspace shell. The signed-in shell uses `src/components/layout/AppShell.jsx`: React owns the outer app wrapper, top bar, grid layout, left navigation drawer, main workspace panel, right inspector drawer, and modal stack. Shared domain helpers remain in focused files such as `src/components/files/fileTree.js`, `src/components/workspaces/workspaceSourceSummary.js`, and `src/utils/formatDate.js`.

`src/main.js` still coordinates app state and API workflow handlers, plus the lightweight public/app path gate for `/` versus `/app`. Shared state factories now live in `src/state/initialState.js`, reset helpers live in `src/state/resetters.js`, user-facing API error mapping lives in `src/utils/friendlyErrors.js`, and Git status decision helpers live in `src/utils/gitStatus.js`. Cohesive API/state mutation workflows live under `src/workflows/`, including session lifecycle mutations, GitHub connection, Pi auth, Pi package management, Git/PR operations, and workspace file/editor operations. Continue extracting cohesive state/workflow areas from `src/main.js` into hooks or services as they are touched.

Styling lives in `src/styles.css`. The interface uses restrained operational styling: dense drawer lists, compact controls, 8px-or-less radii for panels/cards, a terminal-first selected-session view, and collapsible left/right drawers for navigation and inspection.

Session image choices live in `src/config/sessionImages.js`. This is the frontend source of truth for the container image dropdown in the create-session modal, including image capability metadata such as `preview` and `previewQa`. Cloud Functions stores matching capability metadata on new session records so the React session detail can show only the canvases supported by the selected image.

Pi provider choices for the Authentication Center live in `src/config/piAuthProviders.js`. Most providers use API-key entries. The OpenAI ChatGPT Plus/Pro (Codex) provider uses OpenAI's device-code flow and saves an OAuth entry under Pi's `openai-codex` auth key. Configured providers can be deleted per provider from the Authentication Center. Entries created by the Pi CLI/TUI are still displayed after the runner syncs `~/.pi/agent/auth.json` back to Firebase.

## Backend Flow

The frontend calls `src/services/api.js`, which sends authenticated JSON requests to `/api/**`. The Authentication Center uses these APIs to save API-key providers and to run OpenAI Codex subscription login. The active web flow starts OpenAI device login, displays the user code and OpenAI verification link, and polls/exchanges the completed authorization into the stored Pi OAuth credential shape.

`functions/index.js` handles user, workspace, and session operations. Creating a workspace writes explicit source metadata so later flows can distinguish a blank workspace from a GitHub-backed one. Creating a session writes the session document, then provisions a Cloud Run service for that session when an image is available. Session records include the Cloud Run service name, public URL, selected image, image capabilities, resource limits, owner UID, and workspace storage prefix. GitHub sessions also need source metadata so the runner can reconstruct `/workspace` from Git and cache state. Stopping a running session deletes its per-session Cloud Run service and leaves the Firestore session record with `stopped` status. Deleting a session uses the same service cleanup path first, then removes the session document from the workspace session list.

The user profile page displays lifetime and trailing-30-day allocated CPU seconds and memory GiB-seconds from `/api/me`. No quota enforcement is attached to those counters.

The sidebar Files section calls `GET /api/workspaces/{workspaceId}/files`. The backend first verifies workspace ownership, then lists objects in the workspace's configured Cloud Storage bucket and `storagePrefix`. The React frontend renders the returned flat paths as an expandable tree; folder expansion state lives in `src/main.js` and is passed into `src/components/files/WorkspaceFileTree.jsx`. For blank workspaces, this is the durable workspace state. For GitHub workspaces, this is a cached view of the most recently synced working tree, not the canonical repository remote state.

The Skills panel calls authenticated backend routes that proxy to a running `pi-basic` runner. Skill listing and mutations require an active session so the web UI writes the same `/workspace/.pi/skills` tree Pi sees inside the terminal, then syncs those Markdown files as ordinary workspace state. A running Pi agent may need to be restarted to rescan newly saved skills.

The planned Extensions panel will call authenticated backend routes that proxy to a running `pi-basic` runner. For v1, package listing and mutations can require an active session because Pi package installs are runtime operations that need the workspace filesystem, npm/git tooling, and the same project-local settings Pi sees inside the terminal.

Clicking a file opens a modal editor. The editor loads text content with `GET /api/workspaces/{workspaceId}/file?path={path}` and saves text content with `PUT /api/workspaces/{workspaceId}/file?path={path}`. Both endpoints verify workspace ownership, normalize the requested relative path under the workspace storage prefix, reject directory marker paths, reject internal runner cache paths, and cap editor reads/writes at 1 MiB. Editor modal state lives in `src/main.js`; the textarea updates that state without re-rendering on every keystroke so typing remains stable while the syntax-highlight backing layer updates in place.

The Files drawer header also has a compact upload action. It opens the browser file picker and sends each selected file as a raw `POST /api/workspaces/{workspaceId}/file?path={filename}` request. The backend uses the same workspace ownership and path validation as the editor, stores the uploaded bytes in Cloud Storage under the workspace prefix, and caps individual uploads at 10 MiB. Uploaded files appear in the sidebar after the workflow refreshes the file listing. For blank workspaces the uploaded object is immediately durable workspace state; for GitHub workspaces it is cached working-tree state until the user commits and pushes through Git.

The backend already accepts `payload.image` for session creation. If no image is passed, it falls back to `SESSION_RUNNER_IMAGE`.

## Current Design Decisions

- Keep session creation in a modal launched from the workspace sidebar, not as an always-visible form in the main workspace area.
- Keep the active terminal as the top content when a session is selected.
- Store container image choices in a config file so the UI can grow from one image to several without changing form code.
- Treat runner capabilities as explicit image/session metadata. UI elements such as the Preview canvas are shown only when the selected session advertises support for them.
- Use Cloud Run per session. This isolates terminals and lets each session carry its own resource settings and image.
- Use Firebase Hosting rewrites for `/api/**`, so the deployed frontend can call the API without hard-coding Cloud Function URLs. Hosting also rewrites `/app` and `/app/**` to the Vite frontend shell while keeping `/community/**` pointed at the Docusaurus build.
- Treat workspace source mode as an explicit domain concept. Blank workspaces use Cloud Storage as durable state; GitHub workspaces use GitHub as durable state and Cloud Storage as resumability/cache.
- Enforce one active session at a time for GitHub workspaces so two runners cannot race on cached `.git` state and worktree sync.
- Keep Pi skill management additive to terminal tooling. The web Skills panel writes normal Markdown files under `.pi/skills`, matching Pi's discovery rules.
- Keep Pi package management additive to terminal tooling. The web Extensions panel should read and write the same workspace-local Pi settings as `pi install -l ...`, while cross-workspace package memory lives in Firestore as metadata.

## Deployment

Frontend changes are deployed with:

```bash
firebase deploy --only hosting --project pi-agents-cloud
```

Runner container changes require a Cloud Build push and then a Cloud Run service update for existing sessions. New sessions use whatever image the create-session flow passes or the backend default.

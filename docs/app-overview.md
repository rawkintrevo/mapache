# App Overview

Mapache Tools is a Firebase and Cloud Run app for browser-managed cloud terminal sessions.

## Product Shape

The app lets an authenticated user create workspaces and run terminal sessions inside Cloud Run containers. The frontend is intentionally operational rather than marketing-oriented: after sign-in, users manage workspaces, sessions, and the active browser terminal.

The public landing page is served from `/` by `LandingPageScreen`. It is a five-section, snap-scroll product page covering zero-config agent setup, workspace isolation, Cloud Run session architecture, the WebUI authentication center, and transparent usage/cost tracking. The primary Google sign-up CTA uses Firebase sign-in and then navigates to `/app`; secondary docs/blog CTAs point into the Docusaurus community site under `/community/**`. The authenticated workspace shell is served from `/app` and `/app/**`. Firebase Hosting still serves the Docusaurus community site separately under `/community/**`.

The current selected-session experience prioritizes the terminal. When a session is selected, the main workspace panel renders the terminal first and does not show workspace setup content above it. Web-capable sessions also expose a `Preview` canvas beside the terminal canvas; basic sessions do not show that UI. Running GitHub-backed sessions show a Git status panel directly underneath the terminal controls with pull, stage/unstage, commit, push, and connected-repository pull request actions. Navigation lives in a collapsible drawer with individually collapsible Workspaces, Files, and Sessions sections, plus a pinned bottom user avatar menu for opening the profile page, refreshing, and signing out. The right-side drawer now holds individually collapsible sections `Authentication Center`, `Skills`, and `Extensions` so contextual tools that are not part of the active terminal workflow can live beside the terminal without taking over the main workspace area. On desktop, the app shell is viewport-height and the left drawer content, main workspace area, and right drawer scroll independently so long drawer content does not lengthen the whole page. Session creation is available from the active workspace row or from the Sessions section action in the drawer. Runner-dependent panels such as Git status, Skills, and Extensions should only call runner proxy APIs once the selected session has a `serviceUrl`; provisioning, stopped, or failed sessions should leave those panels reset while the main session placeholder shows `status` or `lastError`.

The app now has an explicit architectural split between blank workspaces and GitHub-backed workspaces. Blank workspaces continue to treat Cloud Storage as their durable source of truth. GitHub workspaces treat GitHub as durable and use Cloud Storage as a resumability/cache layer. The create-workspace modal exposes the source choice inline; choosing GitHub loads the GitHub App connected repository picker when available, keeps an HTTPS `github.com/{owner}/{repo}` URL fallback for public repositories, and can include an optional branch. The frontend sends those values inside the `source` object that Cloud Functions validates. The detailed design lives in [github-workspaces.md](./github-workspaces.md).

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

Firebase Auth is the source of user identity. On authenticated API requests, `functions/index.js` verifies the Firebase ID token, checks the optional app-level allow list in Firestore, and upserts a profile document at `users/{uid}` before serving workspace/session data.

The allow list lives at `appConfig/access`. It is disabled when the document is missing or `enabled` is not `true`. When enabled, entries can be supplied through `entries`, `allowedEmails`, and/or `allowedUids`. `entries` accepts Firebase user emails and/or UIDs as strings. Email entries are case-insensitive; UID entries are exact. Prefix `entries` values with `email:` or `uid:` when the type should be explicit:

```js
// appConfig/access
{
  enabled: true,
  entries: ["email:alice@example.com", "uid:firebase-auth-uid"],
  allowedEmails: ["bob@example.com"],
  allowedUids: ["another-firebase-auth-uid"],
  updatedAt: Timestamp
}
```

Users who authenticate successfully but are not on the list receive `app_access_not_allowed` from authenticated `/api/**` routes. The GitHub OAuth callback route remains unauthenticated because it is entered from GitHub before returning to the signed-in app.

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

Users can only see workspaces where `ownerUid` matches their Firebase Auth UID. Workspace deletion requires the same ownership check, stops any child session services, removes the workspace's stored files when its storage prefix is not shared by another workspace, and deletes the workspace document tree. Session list, resize, restart, stop, and delete operations first require ownership of the parent workspace, then operate only on that workspace's session subcollection. Firestore rules mirror this ownership boundary for direct client reads.

## Frontend Structure

The frontend now uses React on top of Vite. The entrypoint is `src/main.js`, which initializes Firebase/Auth, owns the current app state and handlers, and renders `src/App.jsx` through `react-dom/client`.

React UI is organized under `src/components/` with one component per file where practical. `src/App.jsx` selects between the React auth screen, fatal error screen, and the signed-in workspace shell. The signed-in shell uses `src/components/layout/AppShell.jsx`: React owns the outer app wrapper, top bar, grid layout, left navigation drawer, main workspace panel, right inspector drawer, and modal stack. Shared domain helpers remain in focused files such as `src/components/files/fileTree.js`, `src/components/workspaces/workspaceSourceSummary.js`, and `src/utils/formatDate.js`.

`src/main.js` still coordinates app startup, auth, the lightweight public/app path gate for `/` versus `/app`, selected workspace/session orchestration, and Git/session lifecycle flows that depend on the active session. Shared state factories live in `src/state/initialState.js`, reset helpers live in `src/state/resetters.js`, user-facing API error mapping lives in `src/utils/friendlyErrors.js`, and Git status decision helpers live in `src/utils/gitStatus.js`. Cohesive API/state mutation workflows live under `src/workflows/`, including session lifecycle mutations, GitHub connection, Pi auth, Pi package management, Git/PR operations, and workspace file/editor operations.

Frontend handler fan-out is reduced through controller modules under `src/controllers/`. `drawerController.js` owns left/right drawer and drawer-section toggles, `modalController.js` owns modal visibility and profile navigation, `workspaceFilesController.js` owns file tree and editor handlers, and `piPanelsController.js` owns right-drawer Authentication Center, Skills, and Extensions handlers. `src/main.js` creates one grouped `handlers` object and passes it into `AppShell`, so shell and modal wiring can use domain groups instead of a long flat list of callback props. The selected workspace's session list is subscribed directly from Firestore through `src/services/sessionStore.js`, so status badges and selected-session placeholders update as soon as the session document changes. Continue extracting cohesive state/workflow areas from `src/main.js` into controllers, hooks, or services as they are touched.

Styling currently enters through `src/styles.css`. The interface uses restrained operational styling: dense drawer lists, compact controls, 8px-or-less radii for panels/cards, a terminal-first selected-session view, and collapsible left/right drawers for navigation and inspection. The planned stylesheet split is documented in [css-decomposition.md](./css-decomposition.md): keep tokens, base rules, layout primitives, and shared controls global while moving component-specific selectors beside their React components in incremental slices.

Session image choices live in `src/config/sessionImages.js` for the create-session modal, but the frontend config is not a security boundary. Cloud Functions resolves submitted `imageKey` values against its own curated runner image catalog and rejects arbitrary user-supplied image URIs. Older clients that submit one of the exact curated image URIs still resolve to the matching key. Cloud Functions stores matching capability metadata on new session records so the React session detail can show only the canvases supported by the selected image.

Pi provider choices for the Authentication Center live in `src/config/piAuthProviders.js`. Most providers use named API-key entries. The OpenAI ChatGPT Plus/Pro (Codex) provider uses OpenAI's device-code flow and saves OAuth entries for Pi's `openai-codex` auth key. The right sidebar shows saved entries compactly; when the selected session is Pi-based, the Authentication Center shows a `Manage Pi Auth` button above the configured providers that opens a modal to select at most one saved entry per provider for that session. Saving the modal persists `piAuthSelection` on the session and rewrites the running session's `~/.pi/agent/auth.json` when available. Users may need to run Pi's `/reload` command for an already-running agent to reload changed credentials. Entries created by the Pi CLI/TUI are still displayed after the runner syncs `~/.pi/agent/auth.json` back to Firebase.

## Backend Flow

The frontend calls `src/services/api.js`, which sends authenticated JSON requests to `/api/**`. The Authentication Center uses these APIs to save named API-key entries, delete entries, run OpenAI Codex subscription login, and persist per-session Pi auth selections. The active web flow starts OpenAI device login, displays the user code and OpenAI verification link, and polls/exchanges the completed authorization into the stored Pi OAuth credential shape.

`functions/index.js` remains the Cloud Functions backend entrypoint for user, workspace, and session operations. API route parsing lives in `functions/apiRoutes.helpers.js`, and grouped route-to-handler dispatch lives in `functions/apiDispatch.helpers.js` so backend decomposition work can move domain logic without changing public paths. Shared backend setup now lives outside the entrypoint: `functions/backendContext.js` owns Firebase Admin, Firestore, and GoogleAuth initialization; `functions/backendConfig.js` owns Firebase Functions params/secrets, global options, and runtime defaults; and `functions/backendUtils.helpers.js` owns pure shared serializers, validators, path/content helpers, and Cloud/HTTP error helpers. Request auth/profile upsert logic lives in `functions/auth.service.js`, user profile usage rollups and session usage ledger helpers live in `functions/userUsage.service.js`, workspace CRUD plus Cloud Storage file endpoints live in `functions/workspace.service.js`, Cloud Run service create/patch/delete, service-account selection, resource limits, and runner environment construction live in `functions/cloudRun.service.js`, GitHub OAuth/App token, connected repository, runner auth env, session source metadata, and pull request API helpers live in `functions/github.service.js`, and Pi auth storage, OpenAI Codex subscription login, package catalog/proxy behavior, skill proxy behavior, and Pi payload validation live in `functions/pi.service.js`. Creating a workspace writes explicit source metadata so later flows can distinguish a blank workspace from a GitHub-backed one. The preferred create-workspace payload is `source: {type: "blank"}` or a GitHub source object; the backend also accepts the older `source: "blank"` payload so deployed clients do not fail validation. Deleting a workspace stops any child Cloud Run session services, records session usage during shutdown, removes Cloud Storage objects under the workspace prefix unless another workspace still points at that prefix, and deletes the Firestore workspace tree. Creating a session writes the session document, then provisions a Cloud Run service for that session when an image is available. Session records include the Cloud Run service name, public URL, selected image, image capabilities, resource limits, owner UID, and workspace storage prefix. GitHub sessions also need source metadata so the runner can reconstruct `/workspace` from Git and cache state. Stopping a running session deletes its per-session Cloud Run service and leaves the Firestore session record with `stopped` status. Deleting a session uses the same service cleanup path first, then removes the session document from the workspace session list.

The frontend does not iframe the raw Cloud Run session URL directly. For each selected running session, it calls `POST /api/workspaces/{workspaceId}/sessions/{sessionId}/access-url`; the backend verifies workspace/session ownership and returns finite-lifetime terminal and preview URLs signed with the session's browser-access secret. The runner validates those URLs before serving terminal, preview, health, and capability browser surfaces. This browser-access secret is separate from `SESSION_SHUTDOWN_TOKEN`, which remains reserved for backend-to-runner management calls.

Cloud Functions and per-session runners use separate service accounts. `FUNCTION_SERVICE_ACCOUNT` selects the API function identity that manages Cloud Run services and app data. `SESSION_RUNNER_SERVICE_ACCOUNT` selects the runtime identity assigned to each session service through Cloud Run `template.serviceAccount`; provisioning fails closed when it is not configured so sessions do not fall back to the default Compute Engine service account.

The user profile page displays lifetime and trailing-30-day allocated CPU seconds and memory GiB-seconds from `/api/me`. No quota enforcement is attached to those counters.

The sidebar Files section calls `GET /api/workspaces/{workspaceId}/files`. The backend first verifies workspace ownership, then lists objects in the workspace's configured Cloud Storage bucket and `storagePrefix`. The React frontend renders the returned flat paths as an expandable tree; folder expansion state lives in `src/main.js` and is passed into `src/components/files/WorkspaceFileTree.jsx`. For blank workspaces, this is the durable workspace state. For GitHub workspaces, this is a cached view of the most recently synced working tree, not the canonical repository remote state.

The Skills panel calls authenticated backend routes that proxy to a running `pi-basic` runner. Skill listing and mutations require an active session so the web UI writes the same `/workspace/.pi/skills` tree Pi sees inside the terminal, then syncs those Markdown files as ordinary workspace state. A running Pi agent may need to be restarted to rescan newly saved skills.

The planned Extensions panel will call authenticated backend routes that proxy to a running `pi-basic` runner. For v1, package listing and mutations can require an active session because Pi package installs are runtime operations that need the workspace filesystem, npm/git tooling, and the same project-local settings Pi sees inside the terminal.

Clicking a file opens a modal editor. The editor loads text content with `GET /api/workspaces/{workspaceId}/file?path={path}` and saves text content with `PUT /api/workspaces/{workspaceId}/file?path={path}`. Both endpoints verify workspace ownership, normalize the requested relative path under the workspace storage prefix, reject directory marker paths, reject internal runner cache paths, and cap editor reads/writes at 1 MiB. Editor modal state lives in `src/main.js`; the textarea updates that state without re-rendering on every keystroke so typing remains stable while the syntax-highlight backing layer updates in place.

The Files drawer header also has compact upload and download actions. Upload opens the browser file picker and uploads each selected file into the workspace Cloud Storage prefix. Files up to 10 MiB use the raw `POST /api/workspaces/{workspaceId}/file?path={filename}` Cloud Functions path so the backend can apply the same workspace ownership and path validation as the editor. Larger files use the Firebase Storage SDK's resumable upload API directly against the workspace's `storagePrefix`; Storage Rules restrict those writes to authenticated users writing under their own `/workspaces/{uid}/...` tree. Download asks Cloud Functions for a short-lived signed URL for the selected object, then navigates the browser to that URL so binary and large workspace files do not pass through the text editor path or Firebase Storage JavaScript body reads. Uploaded files appear in the sidebar after the workflow refreshes the file listing. For blank workspaces the uploaded object is immediately durable workspace state; for GitHub workspaces it is cached working-tree state until the user commits and pushes through Git.

The backend accepts `payload.imageKey` for session creation and maps it to a curated image URI server-side. Raw `payload.image` values are supported only as a legacy compatibility path when they exactly match a curated image. Unknown user-supplied image URIs are rejected with `invalid_runner_image`. If no image key is passed, the backend falls back to the operator-configured `SESSION_RUNNER_IMAGE`. The default curated image is treated as a shell runner and is provisioned with `bash -l`; Pi images are provisioned with Pi resume mode.

## Current Design Decisions

- Keep session creation in a modal launched from the workspace sidebar, not as an always-visible form in the main workspace area.
- Keep the active terminal as the top content when a session is selected.
- Store container image choices in a config file so the UI can grow from one image to several without changing form code.
- Treat runner capabilities as explicit image/session metadata. UI elements such as the Preview canvas are shown only when the selected session advertises support for them.
- Use Cloud Run per session. This isolates terminals and lets each session carry its own resource settings and image.
- Use Firebase Hosting rewrites for `/api/**`, so the deployed frontend can call the API without hard-coding Cloud Function URLs. Hosting also rewrites `/app` and `/app/**` to the Vite frontend shell while keeping `/community/**` pointed at the Docusaurus build.
- Treat workspace source mode as an explicit domain concept. Blank workspaces use Cloud Storage as durable state; GitHub workspaces use GitHub as durable state and Cloud Storage as resumability/cache.
- Enforce one active Pi/agent session at a time for GitHub workspaces so two agents cannot race on cached `.git` state and worktree sync. Shell sessions may run alongside a Pi session for manual access, with the normal caveat that user edits can still race with agent edits in the shared worktree.
- Keep Pi skill management additive to terminal tooling. The web Skills panel writes normal Markdown files under `.pi/skills`, matching Pi's discovery rules.
- Keep Pi package management additive to terminal tooling. The web Extensions panel should read and write the same workspace-local Pi settings as `pi install -l ...`, while cross-workspace package memory lives in Firestore as metadata.

## Deployment

Frontend changes are deployed with:

```bash
firebase deploy --only hosting --project pi-agents-cloud
```

GitHub Actions also deploys Firebase automatically. The test pyramid and fast-versus-slow check split are documented in [testing.md](./testing.md).

- Pull requests from branches in this repository run `.github/workflows/firebase-preview.yml`, install the root, `community/`, `functions/`, and `session-runner/` dependencies, run the Functions tests, run session runner JavaScript syntax checks, build the app, and deploy a Firebase Hosting preview channel that expires after 14 days.
- Pushes to `main` run `.github/workflows/firebase-production.yml`, perform the same install/test/syntax-check/build checks, and deploy Hosting, Cloud Functions, Firestore, and Storage to the `pi-agents-cloud` project.
- Both workflows expect the repository secret `FIREBASE_SERVICE_ACCOUNT_PI_AGENTS_CLOUD` to contain a Firebase/GCP service account JSON key with deploy access to `pi-agents-cloud`.
- The deploy service account also needs Secret Manager metadata and version access (`roles/secretmanager.viewer` and `roles/secretmanager.secretAccessor`) because the API function binds Firebase Functions secrets such as `GITHUB_APP_ID`. It also needs Cloud Scheduler administration (`roles/cloudscheduler.admin`) because scheduled functions such as `reapIdleSessions` deploy by creating or updating Cloud Scheduler jobs.
- The production workflow writes `functions/.env.pi-agents-cloud` with `FUNCTION_SERVICE_ACCOUNT=mapache-api@pi-agents-cloud.iam.gserviceaccount.com` and `SESSION_RUNNER_SERVICE_ACCOUNT=mapache-runner@pi-agents-cloud.iam.gserviceaccount.com` before `firebase deploy` because the API function uses Firebase Functions parameters for both its Cloud Functions runtime identity and the runtime identity assigned to per-session Cloud Run services. Non-interactive CI deploys fail if either value is absent from Firebase's dotenv-resolved parameter files. Do not use the nonexistent `mapache-session-runner@...` account name for session provisioning.

Runner container changes require a Cloud Build push and then a Cloud Run service update for existing sessions. New sessions use the curated image key selected in the modal, resolved by the backend, or the backend default.

Browser-token enforcement is implemented in the runner image and requires `SESSION_BROWSER_TOKEN_SECRET` in the Cloud Run service environment. New sessions receive this automatically after the Functions deployment. Existing sessions need a restart or recreation after the runner image and Functions changes are deployed.

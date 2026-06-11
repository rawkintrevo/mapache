# Workspace-Local Pi Extension Manager Task List

## Goal

Add a web extension manager for Pi-based runner sessions. The manager should be additive to the existing Pi TUI/CLI tooling: users can still install, remove, update, and configure packages directly inside Pi, and the web UI should reflect those changes after refresh.

Extensions are workspace-local by default. The manager should install packages into the active workspace's project-local Pi configuration, remember packages a user has used across workspaces, and offer known packages for installation into other workspaces without installing them globally by default.

## Task Sizing

- `easy (gpt-5.4-mini)`: narrow docs, schema, validation, focused UI, or small helper work.
- `medium (gpt-5.4)`: runner/backend/frontend coordination, archive sync behavior, or mutating package operations.
- `human`: product/security/account setup or a decision that requires a person.
- If a task starts looking hard, split it before implementation.

## Source Documents

Before implementation tasks, read:

- `AGENTS.md`
- `docs/app-overview.md`
- `docs/runtime-containers.md`
- Relevant sections of `session-runner/server.js`
- Relevant sections of `functions/index.js`
- Relevant sections of `src/services/api.js`, `src/main.js`, `src/ui/render.js`, and `src/styles.css`
- Pi package docs: `https://pi.dev/docs/latest/packages`
- Pi coding-agent package manager source when changing package behavior: `https://github.com/earendil-works/pi/tree/main/packages/coding-agent`

## Architecture Notes

- The web manager must be in addition to Pi's existing TUI/CLI tooling, not a replacement.
- Workspace-local package declarations live in `/workspace/.pi/settings.json`.
- Workspace-local installed npm packages live under `/workspace/.pi/npm/`.
- Workspace-local installed git packages live under `/workspace/.pi/git/`.
- The web UI should default to workspace-local installs, equivalent to `pi install -l ...`.
- Packages installed from the Pi terminal with `pi install -l ...` should appear in the web manager after refresh.
- Packages installed without `-l` write to `/root/.pi/agent/...`; these are user-scoped Pi packages and should not become the default web manager behavior.
- Requiring an active `pi-basic` session for v1 is acceptable.
- The runner should serialize package operations so the web manager and Pi tooling do not mutate package settings at the same time.
- Package code should not be written to the client device. The browser initiates and displays operations only.
- Cross-workspace package memory belongs in Firestore under the authenticated user, not in every workspace.
- The package catalog should remember packages used in any workspace and show them as installable in other workspaces.
- Future favorites can build on the package catalog with a `favorite` field.
- Reuse the runner's archive-backed sync pattern for high-cardinality package install directories. Keep `.pi/settings.json` normally synced, but archive `.pi/npm` and `.pi/git` as runtime cache directories.
- Hide `.pi/npm`, `.pi/git`, and internal archive objects from the Files UI and editor routes.
- For GitHub workspaces, `.pi/settings.json` is portable workspace configuration and may be committed by the user. Installed package directories are runtime cache state.

## Tasks

- [x] 1. **Document the extension manager architecture** - easy (gpt-5.4-mini)
  - Acceptance criteria:
  - Add focused docs describing workspace-local Pi package management.
  - Document where package declarations, installed package code, package catalog metadata, and operation status are written.
  - Document active-session requirement for v1.
  - Document that web management is additive to Pi TUI/CLI tooling.
  - Update overview/runtime docs to point to the new architecture notes.
  - Completed: 2026-06-11. Added `docs/pi-extension-manager.md` and linked it from overview/runtime docs, covering workspace-local package scope, write locations, active-session v1 behavior, package catalog metadata, archive-backed package caches, and additive Pi tooling behavior.

- [x] 2. **Add workspace Pi package archive targets** - medium (gpt-5.4)
  - Acceptance criteria:
  - Runner treats `/workspace/.pi/npm` and `/workspace/.pi/git` as archive-backed runtime cache directories.
  - `.pi/settings.json` remains normal workspace file sync state.
  - Archive objects live under `.mapahce-internal/archives/`.
  - Existing `node_modules`, `.git`, and `/root/.pi` archive behavior remains intact.
  - `node --check session-runner/server.js` passes.
  - Completed: 2026-06-11. Added archive targets for `/workspace/.pi/npm` and `/workspace/.pi/git`, storing them under `.mapahce-internal/archives/` while leaving `/workspace/.pi/settings.json` in normal workspace sync.

- [x] 3. **Hide workspace Pi package cache paths from normal file surfaces** - easy (gpt-5.4-mini)
  - Acceptance criteria:
  - Normal workspace sync skips object-per-file sync for `.pi/npm/` and `.pi/git/`.
  - Files API and file editor routes do not expose `.pi/npm/`, `.pi/git/`, or related internal archive objects.
  - `.pi/settings.json` can still appear as a normal workspace file when present.
  - Runtime docs describe the visibility and sync rules.
  - Completed: 2026-06-11. Normal sync now skips `.pi/npm/` and `.pi/git/`, Cloud Functions hides them from file listings/editor paths, and runtime docs describe visibility rules.

- [x] 4. **Add runner read-only Pi package listing endpoint** - medium (gpt-5.4)
  - Acceptance criteria:
  - Runner exposes a token-protected endpoint for workspace-local Pi packages.
  - Endpoint reads `/workspace/.pi/settings.json` through Pi-compatible settings/package logic when practical.
  - Response includes configured package source, scope, installed path when present, and whether the package is filtered.
  - Packages installed via terminal with `pi install -l ...` appear after refresh.
  - Blank/no-package state returns a stable empty response.
  - Completed: 2026-06-11. Added protected `GET /pi/packages` runner endpoint that reads workspace-local Pi settings, returns stable package metadata with scope/type/filter/install-path information, and handles missing settings as an empty package list.

- [ ] 5. **Add backend read-only package proxy route** - medium (gpt-5.4)
  - Acceptance criteria:
  - Cloud Functions exposes an authenticated route to list packages for an active session.
  - Route verifies workspace and session ownership.
  - Route requires a live runner URL and protected runner token.
  - Errors distinguish no active session, unsupported runner, runner unavailable, and package read failure.
  - No package code or secrets are returned.

- [ ] 6. **Add frontend read-only Extensions panel** - medium (gpt-5.4)
  - Acceptance criteria:
  - Existing right drawer `Extensions` section shows workspace-local installed/configured packages.
  - Panel has refresh, loading, empty, unavailable, and error states.
  - Panel requires an active session for v1 and explains that state without replacing Pi tooling.
  - UI stays compact and consistent with the current operational drawer style.
  - `npm run build` passes.

- [ ] 7. **Add Firestore package catalog schema helpers** - easy (gpt-5.4-mini)
  - Acceptance criteria:
  - Backend has helpers to normalize package source and derive package identity for npm and git sources.
  - Firestore package catalog lives under the authenticated user.
  - Catalog records exact source string, derived identity, type, timestamps, last workspace id, install count, and future `favorite` field.
  - Validation rejects unsupported or unsafe package source strings.

- [ ] 8. **Populate catalog from observed workspace packages** - medium (gpt-5.4)
  - Acceptance criteria:
  - Listing workspace packages records or updates known package catalog entries for the user.
  - Catalog update does not install packages into other workspaces.
  - Exact source strings are preserved for pinned npm versions and pinned git refs.
  - Existing workspace package listing behavior remains correct if catalog writes fail.

- [ ] 9. **Show known packages not installed in current workspace** - medium (gpt-5.4)
  - Acceptance criteria:
  - Extensions panel shows user-known packages from Firestore that are not configured in the active workspace.
  - Known packages have an `Install` action but are not installed automatically.
  - Installed/configured workspace packages remain visually distinct from known packages.
  - The UI can later support favorites without changing the catalog shape.
  - `npm run build` passes.

- [ ] 10. **Add runner package operation lock** - easy (gpt-5.4-mini)
  - Acceptance criteria:
  - Runner serializes package list/install/remove/update operations.
  - Concurrent mutation attempts receive a stable busy response.
  - Read operations either wait for the lock or return a clearly marked busy state.
  - Lock failures cannot leave the runner permanently busy.

- [ ] 11. **Add runner workspace-local package install support** - medium (gpt-5.4)
  - Acceptance criteria:
  - Runner exposes a token-protected install endpoint.
  - Endpoint installs npm and git package sources into workspace-local Pi settings, equivalent to `pi install -l`.
  - Use Pi's exported package manager API when practical; use CLI fallback only if needed.
  - Operation updates `.pi/settings.json` and package cache directories.
  - Operation triggers or schedules archive sync for `.pi/npm` and `.pi/git`.
  - Errors are structured and do not expose credentials.

- [ ] 12. **Add backend package install route** - medium (gpt-5.4)
  - Acceptance criteria:
  - Cloud Functions exposes an authenticated install route for active sessions.
  - Route validates package source and supported type before proxying to the runner.
  - Route verifies workspace/session ownership and active runner availability.
  - Successful install updates the user's package catalog.
  - Failure responses are stable for frontend display.

- [ ] 13. **Add frontend package install flow** - medium (gpt-5.4)
  - Acceptance criteria:
  - Extensions panel supports installing npm and git package sources into the current workspace.
  - Known package rows include an install button.
  - Install form handles busy, success, validation error, and runner error states.
  - Package list refreshes after successful install.
  - `npm run build` passes.

- [ ] 14. **Add runner package remove support** - medium (gpt-5.4)
  - Acceptance criteria:
  - Runner exposes a token-protected remove endpoint.
  - Endpoint removes workspace-local package settings and installed package cache when supported by Pi package behavior.
  - Removing one package does not remove unrelated known catalog entries.
  - Operation triggers or schedules archive sync for package cache directories.
  - Errors are structured and safe to display.

- [ ] 15. **Add backend and frontend remove flow** - medium (gpt-5.4)
  - Acceptance criteria:
  - Backend exposes authenticated package remove route with ownership checks.
  - Frontend package rows include remove action for workspace-installed packages.
  - UI refreshes package state after removal.
  - Known package catalog still offers removed packages as installable in the current workspace.
  - `npm run build` passes.

- [ ] 16. **Add runner package update support** - medium (gpt-5.4)
  - Acceptance criteria:
  - Runner exposes token-protected update endpoints for all packages and a selected package.
  - Update behavior follows Pi package semantics, including pinned npm versions and pinned git refs.
  - Operation uses the package operation lock.
  - Operation triggers or schedules archive sync for package cache directories.
  - Errors are structured and safe to display.

- [ ] 17. **Add backend and frontend update flow** - medium (gpt-5.4)
  - Acceptance criteria:
  - Backend exposes authenticated package update route with ownership checks.
  - Frontend supports update-all and update-one where available.
  - UI shows busy/error/success states and refreshes after update.
  - Pinned package behavior is not misrepresented.
  - `npm run build` passes.

- [ ] 18. **Detect and surface user-scoped Pi packages** - easy (gpt-5.4-mini)
  - Acceptance criteria:
  - Runner listing can detect packages configured in `/root/.pi/agent/settings.json`.
  - Frontend shows user-scoped packages separately from workspace-local packages.
  - User-scoped packages are not treated as installed in the current workspace by default.
  - UI offers a clear path to install the same source workspace-locally.

- [ ] 19. **Add package operation status persistence if needed** - medium (gpt-5.4)
  - Acceptance criteria:
  - If synchronous runner calls are insufficient, add Firestore operation records under the workspace or session.
  - Operation records include action, source, status, timestamps, and safe error message.
  - Frontend can recover operation status after reload.
  - If not needed, document the decision and leave this task marked complete with rationale.

- [ ] 20. **Add regression coverage for package source validation and catalog writes** - easy (gpt-5.4-mini)
  - Acceptance criteria:
  - Add focused tests or test seams for source normalization and identity derivation.
  - Cover npm, scoped npm, pinned npm, git shorthand, git URL, and invalid source cases.
  - Cover catalog merge/update behavior.
  - Existing relevant checks pass.

- [ ] 21. **Run end-to-end package manager regression checks** - human
  - Acceptance criteria:
  - Create or use a `pi-basic` session.
  - Install an npm package from the web UI and verify it appears in `/workspace/.pi/settings.json`.
  - Install a git package from the web UI and verify it appears in `/workspace/.pi/settings.json`.
  - Install a package from inside Pi with `pi install -l ...` and verify the web UI shows it after refresh.
  - Stop/restart the session and verify package settings and package cache restore.
  - Verify a package installed in one workspace appears as known-but-not-installed in another workspace.

- [ ] 22. **Document deployment and existing-session behavior** - easy (gpt-5.4-mini)
  - Acceptance criteria:
  - Runtime docs explain that existing Cloud Run sessions need a new revision or recreation for package manager endpoints and archive targets.
  - Docs include build/deploy commands with explicit `--project pi-agents-cloud` where applicable.
  - Docs note that `functions/` changes should be deployed before handoff in normal implementation work unless explicitly skipped.
  - Docs list the expected storage and Firestore write locations.

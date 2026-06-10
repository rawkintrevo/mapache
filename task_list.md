# GitHub-Backed Workspace Task List

## Goal

Add GitHub-backed workspaces where GitHub is the durable source of truth, the runner checks out an exact commit for initial setup, and Cloud Storage is used as a resumability/cache layer. Blank workspaces should keep the current Cloud Storage source-of-truth behavior.

## Task Sizing

- `easy (gpt-5.4-mini)`: narrow UI, metadata, validation, docs, or small helper work.
- `medium (gpt-5.4)`: cross-file behavior, runner lifecycle, or API/UI coordination.
- `human`: product/security/account setup that requires a person to make choices or configure external systems.
- No task should require `gpt-5.5`. If a task starts looking hard, split it before implementation.

## Source Documents

Before implementation tasks, read:

- `AGENTS.md`
- `docs/app-overview.md`
- `docs/runtime-containers.md`
- The sections of `functions/index.js`, `src/main.js`, `src/ui/render.js`, `src/services/api.js`, and `session-runner/server.js` relevant to the selected task.

## Architecture Notes

- Workspace source modes:
  - `blank`: current behavior; Cloud Storage remains the workspace source of truth.
  - `github`: GitHub repo plus Git state is the base; Cloud Storage stores resumable working tree files, `.git` as an archive, and runtime caches.
- GitHub workspace startup should reconstruct `/workspace` by restoring cached Git state when present, otherwise cloning/fetching the repo and checking out the recorded commit.
- Do not sync `.git/` as normal workspace files. Store it as an internal archive, similar to existing `node_modules` and `/root/.pi` archive behavior.
- Git should remain the conflict model. The app may wrap common actions, but should not invent a separate merge/conflict system.
- GitHub worktree file sync must handle created, modified, and deleted files. The `.git` archive preserves Git state, while normal worktree sync must avoid stale bucket files coming back after deletion.
- A GitHub workspace may have only one active session at a time. This avoids two Cloud Run containers writing competing Git metadata and working tree cache state.
- Initial GitHub support can use pasted HTTPS GitHub repo URLs. Full GitHub App/Connector repo picker work is split into later tasks.
- For `functions/` changes in normal implementation work, deploy Cloud Functions before handoff unless the user explicitly says not to deploy. For `next_task` skill runs, follow that skill's "do not deploy unless explicitly requested" rule.
- Commit messages should start with `Issue #7: Workspace from Repo, ` (for example: `Issue #7: Workspace from Repo, Task 2: validate workspace source payloads`).

## Tasks

- [x] 1. **Document the GitHub workspace architecture** - easy (gpt-5.4-mini)
  - Acceptance criteria:
  - Add focused docs describing `blank` vs `github` workspace source modes.
  - Document exact-commit initial checkout, `.git` archive cache storage, worktree cache storage, one-active-session enforcement, and Git-as-conflict-model decisions.
  - Add a dedicated GitHub workspace design document and update overview docs to point at it.
  - Completed: 2026-06-10. Added `docs/github-workspaces.md` and updated the overview/runtime docs to describe source modes, cache semantics, `.git` archive handling, and single-session enforcement.

- [x] 2. **Add workspace source metadata validation helpers** - easy (gpt-5.4-mini)
  - Acceptance criteria:
  - Add backend helpers in `functions/index.js` to normalize workspace source payloads.
  - Support `blank` and public GitHub HTTPS repo metadata.
  - Reject unsupported repo URLs, embedded credentials, and unsupported source types.
  - Existing blank workspace creation behavior remains unchanged when no source is provided.
  - Completed: 2026-06-10. Added workspace source normalization helpers and wired create-workspace validation for blank and public GitHub HTTPS repo payloads.

- [x] 3. **Persist workspace source metadata on create** - easy (gpt-5.4-mini)
  - Acceptance criteria:
  - `createWorkspace` stores normalized source metadata.
  - Blank workspaces explicitly store `source.type: "blank"` or equivalent stable metadata.
  - GitHub workspaces store repo URL, owner, repo name, requested branch if present, and source status fields.
  - `npm run build` and `npm --prefix functions run lint` pass when feasible.
  - Completed: 2026-06-10. Workspace creation now persists explicit blank source metadata and initializes GitHub source records with repo identity plus status fields.

- [x] 4. **Expose workspace source fields in the create-workspace API client** - easy (gpt-5.4-mini)
  - Acceptance criteria:
  - `src/services/api.js` continues to send JSON workspace create payloads without special cases.
  - Frontend create handlers can pass source fields through cleanly.
  - No behavior changes for existing blank workspace creation.
  - Completed: 2026-06-10. Frontend create plumbing now forwards optional source payloads without changing the generic API client.

- [x] 5. **Add create-workspace UI controls for blank vs GitHub source** - easy (gpt-5.4-mini)
  - Acceptance criteria:
  - Workspace creation UI offers a compact source choice.
  - Blank remains the default.
  - GitHub option accepts repo URL and optional branch.
  - Controls fit the existing drawer style and remain usable on mobile.
  - `npm run build` passes.
  - Completed: 2026-06-10. Added drawer source toggles plus GitHub repo URL/branch fields with mobile-friendly layout.

- [x] 6. **Enforce one active session for GitHub workspaces** - medium (gpt-5.4)
  - Acceptance criteria:
  - Backend rejects creating a new GitHub workspace session when another session for that workspace is provisioning, running, resizing, or otherwise active.
  - Blank workspaces keep existing multi-session behavior.
  - Error response is stable enough for the frontend to show a clear message.
  - Docs explain that this prevents competing writes to cached Git state and worktree files.
  - Completed: 2026-06-10. Added backend GitHub-session reservation checks with a stable 409 message and documented which session states count as active.

- [x] 7. **Pass workspace source metadata into session runner environment** - medium (gpt-5.4)
  - Acceptance criteria:
  - Cloud Run session provisioning includes env vars needed by the runner for GitHub workspaces.
  - Blank sessions keep current env behavior.
  - GitHub env vars include repo URL, branch if present, and exact commit when known.
  - Docs note that existing Cloud Run services need a new revision for runner env changes.
  - Completed: 2026-06-10. Session provisioning now carries source metadata into runner env vars and docs now call out the required Cloud Run revision refresh for existing services.

- [x] 8. **Add runner source-mode detection and blank-mode compatibility checks** - easy (gpt-5.4-mini)
  - Acceptance criteria:
  - Runner has clear source-mode helpers.
  - Blank mode follows the existing `syncDown` then terminal startup behavior.
  - GitHub mode can be detected without changing blank behavior.
  - `node --check session-runner/server.js` passes.
  - Completed: 2026-06-10. Added workspace source-mode helpers and startup logging while preserving blank-mode sync/start behavior.

- [x] 9. **Implement public GitHub clone and exact checkout in the runner** - medium (gpt-5.4)
  - Acceptance criteria:
  - Runner can clone a public GitHub repo into `/workspace`.
  - Runner checks out the exact commit when provided.
  - If only a branch is provided, runner resolves and records the checked-out commit when practical.
  - Clone errors are logged clearly and surfaced to the session document when feasible.
  - `.git/` is not uploaded by normal workspace sync.
  - Completed: 2026-06-10. Runner now clones GitHub workspaces on startup, force-checks out requested commits, records resolved HEAD info on the session, logs clone failures to `lastError`, and skips `.git` during GitHub-mode normal sync.

- [x] 10. **Record resolved Git commit metadata from runner startup** - medium (gpt-5.4)
  - Acceptance criteria:
  - Runner writes resolved branch and commit SHA back to the session and/or workspace document.
  - Startup metadata does not overwrite user-facing repo settings unexpectedly.
  - Failure states distinguish clone failure from sync failure.
  - Backend/frontend can display the resolved commit later.
  - Completed: 2026-06-10. Runner now publishes resolved branch/commit plus source status to session and workspace docs, while keeping requested repo settings intact and separating clone vs sync failure states.

- [x] 11. **Introduce app-owned sync ignore policy metadata** - easy (gpt-5.4-mini)
  - Acceptance criteria:
  - Workspace metadata can carry a sync policy.
  - GitHub workspaces default to cache exclusions such as `.git/` normal file sync, `node_modules/`, build outputs, and internal state.
  - Blank workspaces keep current effective sync behavior.
  - Policy is documented in `docs/runtime-containers.md`.
  - Completed: 2026-06-10. Workspace records now persist a source-aware syncPolicy field, and runtime docs describe the blank vs GitHub defaults.

- [x] 12. **Apply sync ignore policy in runner upload/download paths** - medium (gpt-5.4)
  - Acceptance criteria:
  - Runner sync ignores policy-excluded paths during normal file sync.
  - Existing archive sync behavior for dependency/runtime caches is preserved or intentionally adjusted.
  - Directory marker behavior still works for non-excluded directories.
  - `node --check session-runner/server.js` passes.
  - Completed: 2026-06-10. Runner now receives sync policy env vars, applies policy exclusions during normal upload/download sync, preserves archive-backed paths, and keeps directory markers for non-excluded directories.

- [x] 13. **Add archive sync support for workspace .git directories** - medium (gpt-5.4)
  - Acceptance criteria:
  - Runner stores `/workspace/.git` as an internal gzip archive for GitHub workspaces.
  - `.git` archive objects live under the hidden internal storage prefix.
  - `.git/` is never listed in the Files sidebar or editable through file routes.
  - Archive upload avoids obvious transient lock files where practical and logs archive failures clearly.
  - Completed: 2026-06-10. Runner now uploads GitHub workspace `.git` state as a hidden internal archive, skips obvious `.lock` files while packaging it, and logs archive upload/restore failures per target.

- [x] 14. **Reconcile GitHub worktree sync including deletions** - medium (gpt-5.4)
  - Acceptance criteria:
  - GitHub workspace normal file sync uploads current non-ignored worktree files.
  - Remote cached worktree files that no longer exist locally are removed or otherwise prevented from restoring.
  - Blank workspace sync behavior is not changed unless explicitly necessary.
  - Directory markers remain consistent after local directory deletion.
  - Completed: 2026-06-10. GitHub-mode normal sync now reconciles stale cached worktree files and directory markers in Cloud Storage after local deletions, while blank workspaces keep the existing upload-only flow.

- [x] 15. **Restore GitHub workspace from cached .git archive and worktree files** - medium (gpt-5.4)
  - Acceptance criteria:
  - Startup order restores cached `.git` archive when present, restores cached worktree files, then validates Git status.
  - If no cached `.git` archive exists, startup clones/fetches the repo and checks out the exact commit or branch.
  - Restore handles missing cache gracefully.
  - Failure logs identify whether Git archive restore, clone, checkout, or worktree restore failed.
  - Completed: 2026-06-10. GitHub startup now restores cached `.git` first when available, falls back to clone/checkout when missing, restores worktree and other archives in order, validates HEAD, and logs phase-specific restore failures.

- [x] 16. **Display GitHub source summary in workspace UI** - easy (gpt-5.4-mini)
  - Acceptance criteria:
  - Workspace rows or header display repo/branch/short SHA for GitHub workspaces.
  - Blank workspaces continue showing storage prefix or current equivalent.
  - UI stays compact and consistent with existing drawer/header design.
  - `npm run build` passes.
  - Completed: 2026-06-10. Workspace rows and the selected workspace header now show compact GitHub repo/branch/short-SHA summaries, while blank workspaces continue showing the storage prefix.

- [x] 17. **Add backend route for Git status summary** - medium (gpt-5.4)
  - Acceptance criteria:
  - Add an authenticated API endpoint for active-session Git status summary.
  - Endpoint verifies workspace/session ownership.
  - Backend proxies or requests status from the runner rather than reading Cloud Storage as Git state.
  - Status includes branch, commit, dirty counts, ahead/behind when available, and conflicted state when available.
  - Completed: 2026-06-10. Added an authenticated session-scoped Git status route in Cloud Functions that verifies ownership, requires a live runner, and proxies to the protected runner Git status endpoint.

- [x] 18. **Add runner endpoint for Git status summary** - medium (gpt-5.4)
  - Acceptance criteria:
  - Runner exposes a protected status endpoint for GitHub workspaces.
  - Status is derived from Git commands in `/workspace`.
  - Endpoint does not expose secrets or arbitrary command execution.
  - Blank workspaces return a clear non-Git status.
  - Completed: 2026-06-10. Runner now exposes a token-protected `/git/status` endpoint backed by fixed Git commands, and blank workspaces return a structured non-Git response.

- [ ] 19. **Add frontend Git status panel skeleton** - easy (gpt-5.4-mini)
  - Acceptance criteria:
  - UI has a compact Git panel for GitHub workspaces with branch, commit, dirty counts, ahead/behind when available, and conflict state.
  - The panel handles loading, unavailable, and non-Git workspace states.
  - No mutating Git actions are added yet.
  - `npm run build` passes.

- [ ] 20. **Add Git fetch/pull action plumbing** - medium (gpt-5.4)
  - Acceptance criteria:
  - Runner supports a protected fetch/pull action for GitHub workspaces.
  - Backend exposes an authenticated route that verifies ownership and calls the runner.
  - UI adds a fetch or pull control with busy/error states.
  - Git conflict results are surfaced as Git state, not custom merge logic.

- [ ] 21. **Add stage and unstage action plumbing** - medium (gpt-5.4)
  - Acceptance criteria:
  - Runner supports staging and unstaging selected files.
  - Backend validates paths and verifies ownership.
  - UI can stage/unstage files from the Git panel.
  - Path validation prevents escaping `/workspace`.

- [ ] 22. **Add commit action plumbing** - medium (gpt-5.4)
  - Acceptance criteria:
  - Runner supports creating a commit with a user-provided message.
  - Backend validates message presence and ownership.
  - UI exposes commit message input and commit button.
  - Empty commits are rejected unless explicitly supported by a later task.

- [ ] 23. **Add push branch action plumbing** - medium (gpt-5.4)
  - Acceptance criteria:
  - Runner supports pushing the current branch using configured GitHub credentials.
  - Backend/runner do not log credentials.
  - UI shows push success/failure and refreshes Git status.
  - If credentials are unavailable, the error clearly says GitHub auth is not configured.

- [ ] 24. **Add GitHub App/Connector planning doc for private repos and repo picker** - easy (gpt-5.4-mini)
  - Acceptance criteria:
  - Add a focused doc section or new doc describing GitHub App installation, repo picker, short-lived tokens, private repo cloning, and PR creation.
  - Clearly separate future GitHub App work from current public-URL support.
  - Identify required security decisions before implementation.

- [ ] 25. **Decide GitHub App ownership and permission policy** - human
  - Acceptance criteria:
  - Decide whether the GitHub App is owned by a personal account, organization, or deployment-specific GitHub org.
  - Decide required permissions for repository contents, metadata, pull requests, and webhooks.
  - Decide whether the app supports all repositories or only selected repositories per installation.
  - Record decisions in the GitHub App planning doc before implementation continues.

- [ ] 26. **Create the GitHub App in GitHub** - human
  - Acceptance criteria:
  - Create the GitHub App with the chosen owner and permission policy.
  - Configure callback/webhook URLs for the deployed `pi-agents-cloud` environment or clearly mark them pending if backend routes do not exist yet.
  - Generate the app private key and record where it is stored, without committing secret values.
  - Record the GitHub App ID, client ID, and installation URL location in private operational notes or deployment configuration.

- [ ] 27. **Configure GitHub App secrets for Firebase/Cloud Functions** - human
  - Acceptance criteria:
  - Store GitHub App private key, app ID, client ID, client secret if needed, and webhook secret in the approved secret manager or Firebase Functions secret mechanism.
  - Confirm no secret values are committed to this repository.
  - Record the deploy-time secret names in docs or deployment notes.

- [ ] 28. **Install the GitHub App on a test repository** - human
  - Acceptance criteria:
  - Install the app on at least one low-risk test repository.
  - Confirm the app has access only to intended repositories.
  - Confirm the installing user/account can be used for end-to-end repo picker and clone testing.

- [ ] 29. **Create GitHub connection metadata schema** - easy (gpt-5.4-mini)
  - Acceptance criteria:
  - Define Firestore document shapes for GitHub installation/user/repo metadata.
  - Do not store secret token values in docs.
  - Include ownership and permission boundaries.
  - Add docs/tests where appropriate.

- [ ] 30. **Add GitHub repo picker API placeholder with clear unsupported response** - easy (gpt-5.4-mini)
  - Acceptance criteria:
  - Add authenticated backend route shape for listing connected repos.
  - Until GitHub App auth exists, route returns a stable `not_configured` response.
  - Frontend can safely detect the unavailable state later.
  - Existing routes are unaffected.

- [ ] 31. **Add repo picker UI unavailable state** - easy (gpt-5.4-mini)
  - Acceptance criteria:
  - Workspace creation UI has a place for connected-repo selection.
  - When repo picker API returns `not_configured`, UI falls back to public repo URL entry.
  - No fake connected repos are shown.
  - `npm run build` passes.

- [ ] 32. **Implement GitHub App installation token creation** - medium (gpt-5.4)
  - Acceptance criteria:
  - Backend can create a short-lived GitHub App installation token using configured secrets.
  - Token values are never logged or stored in Firestore.
  - Errors distinguish missing configuration, invalid installation, and GitHub API failures.
  - Unit/syntax checks pass where feasible.

- [ ] 33. **Implement connected repo picker backend** - medium (gpt-5.4)
  - Acceptance criteria:
  - Repo picker API lists repositories available through installed GitHub App installations.
  - Endpoint verifies the authenticated app user can access the returned installation/repository records.
  - Response includes owner, repo name, default branch, privacy flag, and installation id.
  - Placeholder `not_configured` behavior remains for environments without GitHub App secrets.

- [ ] 34. **Wire connected repo picker into workspace creation UI** - medium (gpt-5.4)
  - Acceptance criteria:
  - Workspace creation can select a connected GitHub repository when the repo picker is configured.
  - Public repo URL entry remains available as a fallback.
  - Selected connected repo payload includes enough metadata for backend validation.
  - `npm run build` passes.

- [ ] 35. **Support private repo clone with installation tokens** - medium (gpt-5.4)
  - Acceptance criteria:
  - Runner can clone private connected repos using a short-lived installation token supplied by the backend.
  - Tokens are passed without logging and are not stored in Cloud Storage or normal workspace files.
  - Public repo clone behavior still works.
  - Failure messages distinguish auth failure from repo-not-found and network failure.

- [ ] 36. **Decide PR creation and branch naming policy** - human
  - Acceptance criteria:
  - Decide whether the app pushes directly to selected branches or always creates working branches.
  - Decide branch naming format for agent-created branches.
  - Decide PR title/body defaults and whether draft PRs are preferred.
  - Record decisions before implementing PR creation.

- [ ] 37. **Add pull request creation plumbing** - medium (gpt-5.4)
  - Acceptance criteria:
  - Backend can request PR creation for a pushed GitHub workspace branch.
  - GitHub API calls use short-lived installation tokens.
  - UI exposes an Open PR action after successful push or when a branch is ahead.
  - Branch protection failures are surfaced as GitHub/Git state, not custom policy logic.

- [ ] 38. **Add focused regression checklist for GitHub-backed workspaces** - easy (gpt-5.4-mini)
  - Acceptance criteria:
  - Add a docs checklist covering blank workspace regression, one-active-session enforcement, public GitHub clone, exact checkout, `.git` archive restore, worktree deletion sync, ignored paths, and Git panel actions.
  - Include commands to validate frontend, functions, and runner syntax/build checks.
  - Keep checklist concise enough to use before deployment.

## Future Larger Work

These are intentionally not implementation tasks yet because they may need additional product/security decisions before coding:

- Multi-user/shared workspace permissions.
- Multiple active sessions for one GitHub workspace via per-session branches or worktrees.
- Server-side cache optimization for very large `.git` archives.

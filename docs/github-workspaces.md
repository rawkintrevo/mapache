# GitHub Workspaces

GitHub-backed workspaces are a second workspace mode for Mapache Tools.

The current app assumes that Cloud Storage is the durable source of truth for a workspace. That works well for blank workspaces, but it is the wrong model for a repository-centric workflow. A GitHub workspace changes that contract:

- GitHub is the durable source of truth for repository history and shared code state.
- Cloud Storage is a resumability and cache layer for the checked-out working tree, the `.git` directory, and other runtime state that should survive a stopped session.
- The runner reconstructs `/workspace` from Git and cache state before serving the terminal.
- Git remains the authority for branch movement, merge behavior, conflicts, staged changes, and local commit state.

This document is intentionally more detailed than the high-level app overview. It records the intended design before implementation is complete so later tasks can align on the same model.

## Goals

The feature should make a GitHub repository feel like a natural base for a workspace without turning Mapache Tools into a separate version-control system.

Primary goals:

- Let a user create a workspace from a GitHub repository.
- Start the first session from an exact repository state.
- Preserve in-progress terminal work when a session stops, idles out, or is recreated.
- Keep repository semantics inside Git instead of inventing parallel conflict logic in Firestore or Cloud Storage.
- Keep blank workspaces working as they do today.

Non-goals for the first implementation:

- Full multi-user collaboration in one workspace.
- Multiple active Pi/agent writer sessions for one GitHub workspace.
- Arbitrary Git provider support beyond GitHub.
- Replacing GitHub pull requests, branch protection, or merge policy with custom app logic.

## Workspace Modes

Mapache Tools should explicitly support two workspace source modes.

### Blank workspaces

Blank workspaces keep the current behavior:

- The workspace record owns a `storagePrefix`.
- Cloud Storage is the source of truth for synced files.
- Sessions restore files from Cloud Storage into `/workspace`.
- Multiple sessions can exist at once, subject to current app behavior.

### GitHub workspaces

GitHub workspaces add repository source metadata and change the persistence contract:

- The workspace points at a GitHub repository and an intended branch or commit.
- GitHub is the canonical source of repository history.
- The runner restores cached state when present, otherwise clones the repository.
- Cloud Storage preserves resumable state, not the canonical project history.
- Only one active Pi/agent session is allowed per GitHub workspace at a time.
- Shell-kind sessions may run alongside an active Pi session for manual access.

The one-agent-session rule is deliberate. Two running agents writing the same cached `.git` state and working tree would produce nondeterministic results and silent corruption risk. Shell sessions are an exception for manual inspection and intervention; they do not share Pi conversation state, but user edits in the shell can still race with agent edits in the shared worktree. If broader multi-session GitHub workspaces are needed later, they should use per-session branches, worktrees, or another isolation boundary.

## Source of Truth Model

The key architectural decision is separating durability from resumability.

### GitHub is durable

GitHub owns:

- repository commits
- branch heads
- merge and rebase behavior
- pull requests
- conflict semantics
- the shared remote state a user eventually pushes

If Cloud Storage vanished but GitHub still existed, a GitHub workspace should still be reconstructible, though any unpushed local work would be lost.

### Cloud Storage is resumable

Cloud Storage owns:

- cached working tree files for the last active session
- archived `.git` state for the last active session
- existing archive-backed runtime state such as `node_modules` and `/root/.pi`
- internal metadata needed to rebuild the workspace locally

If GitHub is temporarily unavailable but Cloud Storage cache exists, the app may still be able to resume the prior local state. That is a performance and resilience benefit, not the primary contract.

## Proposed Firestore Shape

The current workspace document is small. GitHub-backed workspaces should extend it with explicit source metadata instead of inferring mode from ad hoc fields.

Illustrative shape:

```js
{
  ownerUid: "firebase-auth-uid",
  userPath: "users/firebase-auth-uid",
  name: "my-repo",
  bucket: "pi-agents-cloud.firebasestorage.app",
  storagePrefix: "workspaces/firebase-auth-uid/my-repo",
  source: {
    type: "github",
    repoUrl: "https://github.com/owner/repo.git",
    owner: "owner",
    repo: "repo",
    requestedBranch: "main",
    requestedCommit: null,
    resolvedBranch: "main",
    resolvedCommit: "abc123...",
    visibility: "public"
  },
  syncPolicy: {
    mode: "github-cache",
    exclude: [
      ".git/",
      "node_modules/",
      "dist/",
      "build/",
      ".next/",
      ".mapahce-internal/"
    ]
  },
  createdAt: Timestamp,
  updatedAt: Timestamp
}
```

Blank workspaces should also carry explicit source metadata:

```js
source: { type: "blank" }
```

That keeps workspace mode a first-class concept in the backend and frontend.

## Session Model Changes

Session records already track Cloud Run identity and runtime status. GitHub sessions should add enough source information for the runner to reconstruct `/workspace` without rereading large amounts of state from Firestore or guessing from storage layout.

Illustrative additional session fields:

```js
{
  workspaceId: "...",
  sourceType: "github",
  sourceRepoUrl: "https://github.com/owner/repo.git",
  sourceRequestedBranch: "main",
  sourceRequestedCommit: null,
  sourceResolvedBranch: "main",
  sourceResolvedCommit: "abc123...",
  gitStatusSummary: {
    branch: "feature/foo",
    head: "def456...",
    ahead: 1,
    behind: 0,
    modified: 3,
    staged: 1,
    deleted: 1,
    conflicted: 0
  }
}
```

Not all of this needs to ship in the first implementation, but the design should assume that Git status is session-derived runtime state rather than something the Files API infers from Cloud Storage listings.

## Create Workspace Flow

The create-workspace UI should grow from a single text input into a source-aware control surface.

Expected UX:

1. User enters workspace name.
2. User chooses a source mode: `Blank` or `GitHub`.
3. For `GitHub`, the UI accepts a public repo URL and optional branch at minimum, and when the GitHub App is configured it can also offer a connected-repository picker.
4. The backend validates and normalizes the source payload.
5. The workspace document is created with explicit source metadata.

The public GitHub URL flow remains the lowest-common-denominator fallback. Connected repository selection now persists installation-scoped source metadata, and private connected repos can clone during session startup by using a short-lived GitHub App installation token minted by the backend for runner startup only.

## Session Creation Flow

Blank and GitHub workspaces diverge at session creation time.

### Blank session creation

The current flow remains:

1. Backend creates the session document.
2. Backend provisions the Cloud Run service.
3. Runner syncs `/workspace` down from Cloud Storage.
4. Runner starts the terminal process.

### GitHub session creation

The GitHub flow adds a stricter session policy and different reconstruction order:

1. Backend verifies the workspace is GitHub-backed.
2. Backend checks whether another non-shell session for that workspace is already active when the requested session is also non-shell.
3. If an active non-shell session exists and the requested session is non-shell, session creation fails with a stable user-facing error.
   Active means any non-terminal session state that could still own or mutate the cached Git/worktree state, such as `provisioning`, `running`, `resizing`, `restarting`, `stopping`, `update_failed`, or `stop_failed`. Shell-kind sessions are exempt from this guard so users can keep manual shell access alongside a Pi session.
4. If not, backend creates the session document with source metadata.
5. Backend provisions the Cloud Run service and passes source metadata in env vars.
6. Runner reconstructs `/workspace` from cache and/or Git.
7. Runner starts the terminal process.

The enforcement point should live in the backend. The frontend can show a better error message, but it should not be trusted to guarantee the active agent-session invariant.

## Git Controls UI

GitHub-backed sessions expose repository actions in the selected-session view, directly under the terminal and session controls. The panel is shown only for live sessions in workspaces whose source metadata is GitHub-backed, with session `sourceType: "github"` as a fallback signal, so blank workspace sessions do not show repository controls. It reads Git status from the runner and offers pull, stage/unstage, commit, push, and pull request actions; pull request creation is limited to connected GitHub App repositories where the backend can mint installation-scoped credentials.

## Runner Reconstruction Flow

The runner should rebuild `/workspace` in phases.

### Phase 1: prepare directories

- Ensure `/workspace` exists.
- Ensure internal archive targets exist.

### Phase 2: restore Git state

For GitHub workspaces:

- If a cached `.git` archive exists in internal storage, restore it to `/workspace/.git`.
- Otherwise clone the repository and check out the requested commit or branch.
- For private connected repos, the backend supplies a short-lived installation token to the runner for clone auth only; the runner must not write that token into normal workspace files or persist it in Cloud Storage.

The `.git` directory should not be synced object-by-object through normal Cloud Storage file listing. It should be treated like archive-backed runtime state because it has many small files and is vulnerable to partial-sync corruption.

### Phase 3: restore working tree

- Restore normal worktree files from Cloud Storage, excluding ignored and internal paths.
- If a cached `.git` archive was restored, the runner should validate that the worktree and Git state are coherent.
- Deleted files must stay deleted. This means normal worktree sync cannot just upload new files; it must also prevent stale cached files from being restored later.

### Phase 4: restore runtime caches

- Restore archive-backed directories such as `node_modules` and `/root/.pi`.
- Keep this logic separate from `.git`, even if the archive machinery is shared.

### Phase 5: publish runtime status

- Resolve the current branch and commit.
- Write resolved source metadata and any useful Git status summary back to Firestore.
- Update only runtime-derived source fields such as `resolvedBranch`, `resolvedCommit`, `status`, and `statusMessage`; do not overwrite user-selected repo settings like repo URL or requested branch.
- Start the PTY and accept terminal connections.

## Why `.git` Is Archived Instead of Normally Synced

The design deliberately avoids treating `.git/` like an ordinary folder in the Files API and normal sync loop.

Reasons:

- `.git/` contains many small files, which is a poor match for Cloud Storage object-per-file sync.
- Partial object sync can leave the repository in a corrupt or misleading state.
- `.git/config` and related files need tighter control than normal user-visible files.
- Lock files and transient Git internals should not be exposed through the app file browser.
- The app already has an internal archive mechanism for high-cardinality runtime directories. `.git` fits that pattern.

This is not just a performance optimization. It is a consistency boundary.

## Normal File Sync Rules for GitHub Workspaces

GitHub workspaces still need working tree file sync outside `.git`.

That sync should:

- include ordinary project files that affect the working tree
- exclude `.git/`
- exclude existing runtime cache paths such as `node_modules/` and `/root/.pi`
- exclude internal storage objects under `.mapahce-internal/`
- remove or invalidate stale cached files after local deletion

This gives the app a reasonable recovery path for uncommitted file edits while still letting Git own repository semantics.

## Git Control Surface

The eventual Git UI should wrap common commands, not reinterpret them.

Expected control surface:

- branch and short SHA display
- ahead/behind summary
- changed files summary
- stage and unstage
- commit message and commit
- fetch and pull
- push
- open pull request

The Git panel should read live state from the active session through runner-backed APIs. It should not infer Git status from Cloud Storage alone.

### Pull request creation flow

PR creation is only supported for GitHub App-connected repositories because the backend must mint a short-lived installation token for the GitHub API call.

The intended flow is:

1. Read live Git state from the runner.
2. Resolve the repository default branch from GitHub.
3. If the current branch is the default branch, require a short kebab-case description and create a new `mapache/<description>` working branch in the runner.
4. Fail clearly if that working-branch name already exists locally or remotely.
5. Push the working branch with a short-lived installation token.
6. Default the PR title from the first commit subject on the working branch (or the head commit subject for a single-commit branch).
7. Prefer the repository PR template when one exists on the default branch; otherwise use a small fallback body template.
8. Create the PR against the repository default branch, ready for review by default unless the user chooses draft.

This keeps PR state inside GitHub while still letting the app help with the branch/push/create plumbing.

## Files Sidebar Expectations

The existing Files section reads from Cloud Storage. That works for blank workspaces and still works as a cache view for GitHub workspaces, but readers need to understand the difference:

- For blank workspaces, Files is the durable project state.
- For GitHub workspaces, Files is a cached view of the latest synced working tree.
- `.git` and internal archive objects must stay hidden from file listing and editing routes.
- Short periods of lag are acceptable because synced cache is not the canonical Git history.

This is an important conceptual distinction for future maintainers. A GitHub workspace file browser is showing resumable local state, not the repository remote itself.

## Failure Modes

The implementation should distinguish these failures clearly:

- invalid repo metadata at workspace creation time
- clone failure
- checkout failure
- `.git` archive restore failure
- worktree file restore failure
- archive upload failure during periodic sync
- blocked session creation because another GitHub session is active
- GitHub authentication failure for private repo support

These failures should not collapse into one generic "workspace sync failed" error if the app can reasonably separate them.

The current runner should therefore distinguish at least:

- `clone_failed` when repository clone or checkout fails before the worktree cache restore phase
- `sync_failed` when Git clone succeeds but Cloud Storage worktree/archive restore fails afterward

Those states belong in runtime metadata such as session fields and workspace `source.status` / `source.statusMessage` so later UI can display the difference.

## Security and Credential Boundaries

Public repository support can work from URL validation alone.

Private repository support should use short-lived GitHub App installation tokens rather than long-lived user tokens stored in workspace metadata. When that work lands:

- tokens should be created server-side
- tokens should be passed to the runner only for the operations that need them
- tokens should never be logged
- tokens should never be stored in Firestore or Cloud Storage

This design doc assumes that GitHub App work is a follow-on capability, not a prerequisite for the public-repo architecture.

For a step-by-step guide to creating and configuring the GitHub App, see [guides/github-app-setup.md](./guides/github-app-setup.md).

For the architecture decision record covering ownership, permissions, and repository scope, see [adrs/adr-0001-github-app-ownership-and-permissions.md](../../adrs/adr-0001-github-app-ownership-and-permissions.md).

## Why One Active Session Is Enforced

The app currently supports multiple sessions per workspace. That is safe for blank workspaces because Cloud Storage is treated as the source of truth and the data model is already coarse-grained.

It is not safe for GitHub workspaces once `.git` cache and working tree cache become part of resumability. Two active sessions would create races in:

- branch pointer movement
- index state
- staged versus unstaged changes
- periodic worktree sync
- `.git` archive upload
- final shutdown sync

The first GitHub implementation should therefore enforce a single active Pi/agent writer session per workspace while allowing shell-kind sessions for manual access. Later expansion to multiple agent sessions should only happen with explicit isolation, such as per-session worktrees or branch sandboxes.

## Deployment Implications

This feature changes runner behavior, workspace sync expectations, and session provisioning fields. That means:

- `docs/app-overview.md` should summarize the new workspace source model.
- `docs/runtime-containers.md` should describe `.git` archive behavior and GitHub reconstruction order.
- `docs/guides/github-workspace-regression-checklist.md` should be used as the compact pre-deploy validation list.
- Existing Cloud Run sessions will not pick up runner changes automatically.
- New runner images require a Cloud Build push.
- Existing session services need a new Cloud Run revision if they must adopt the new runner behavior without being recreated.

## Relationship to the Task List

This document is the architectural reference for the GitHub workspace tasks in [task_list.md](/home/rawkintrevo/gits/rawkintrevo/mapahce/task_list.md). The task list should stay implementation-sized; this page should stay explanation-sized.

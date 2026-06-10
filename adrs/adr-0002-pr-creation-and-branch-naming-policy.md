# ADR-0002: PR Creation and Branch Naming Policy

- Status: Accepted
- Date: 2026-06-10
- Owners: Mapache Tools maintainers
- Related tasks: Task 36 (Decide PR creation and branch naming policy), Task 37 (Add pull request creation plumbing)

## Context

Mapache Tools now supports GitHub-backed workspaces with clone, status, stage, commit, pull, and push actions. Before implementing pull request creation, the project needs a stable policy for:

1. Whether the app may push directly to a selected branch
2. How agent-created working branches are named
3. Whether working branches are reused or unique per change set
4. Default PR creation behavior, title, and body
5. Which base branches are valid PR targets
6. How branch-name collisions are handled

These decisions affect safety, user expectations, branch hygiene, and the UI/backend contract for upcoming PR workflows.

## Decision

### Branch strategy: always use a working branch

Mapache Tools will **not** open pull requests from direct pushes to the selected base branch. Agent-authored changes intended for PR creation must use a separate working branch.

**Rationale:**

- Avoids direct modification of the base branch during PR-oriented flows
- Keeps PR review behavior aligned with normal GitHub collaboration expectations
- Reduces the chance of an agent mutating a shared branch unexpectedly
- Keeps branch protection and repository policy enforcement inside GitHub

### Working branch naming

Agent-created working branches will use this format:

```text
mapache/<short-desc-in-kabob>
```

Examples:

```text
mapache/fix-login-timeout
mapache/add-pr-open-action
```

Rules:

- `short-desc-in-kabob` should be concise and human-readable
- lowercase letters, numbers, and hyphens are preferred
- no user identity, Firebase UID, or other human/account identifier is included in the branch name

### Branch lifecycle: unique branch per change set

Each PR or change set should use a **new branch**, not a stable branch reused by the workspace.

**Rationale:**

- Keeps PR history easier to reason about
- Avoids accidental carryover of old commits into a later PR
- Matches the expectation that a PR represents a bounded unit of work

### Branch-name collision handling

If `mapache/<short-desc-in-kabob>` already exists remotely or locally in a way that would conflict with PR creation, the app should **fail and ask the user** for a different short description.

The app should **not** auto-append timestamps, IDs, or nested path segments to force uniqueness.

**Rationale:**

- Preserves readable, intentional branch names
- Avoids opaque naming schemes that make branch purpose harder to understand
- Makes the naming contract predictable for users and future tooling

### PR default state

The UI should allow the user to choose whether to open the PR as draft or ready for review. The default should be:

- **Ready for review**

**Rationale:**

- Keeps the UI flexible for future workflows
- Uses a sensible default for the common case without forcing draft-only behavior

### PR title default

The default PR title should be the **first commit message** on the working branch, or the current head commit message when creating a single-commit PR.

**Rationale:**

- Reuses text the user or agent already authored
- Encourages meaningful commit messages
- Minimizes extra title-writing friction in the UI

### PR body default

PR body generation should prefer the repository's PR template when available:

1. If `.github/pull_request_template.md` or equivalent repo-supported template exists, use it
2. Otherwise, fall back to an app-provided default template

The fallback template should remain minimal and implementation-oriented.

**Rationale:**

- Defers to repository-local workflow when present
- Keeps Mapache Tools compatible with repo-specific review expectations
- Avoids inventing a mandatory global PR body format

### Allowed base branch

Initial PR creation support should target the repository's **default branch only**.

The app should not allow PR creation against arbitrary non-default base branches in the first implementation.

**Rationale:**

- Simplifies backend validation and UI behavior
- Matches the most common case
- Reduces branch-selection ambiguity while PR support is still new

## Consequences

### Positive

- PR-oriented flows are safer because they do not rely on direct base-branch pushes
- Branch names stay readable and predictable
- Repo PR templates remain the primary source of review/body structure
- Limiting the base branch to the default branch keeps the first implementation smaller and clearer

### Negative

- Users must supply a different short description if a branch name collides
- Some repositories rely on non-default integration branches; those workflows are not supported initially
- First-commit-message title defaults may be weak if commit hygiene is poor

### Risks

- Branch-collision failures may feel inconvenient without good UI guidance
- Repositories with multiple PR templates may need extra design later
- Default-branch-only support may be too restrictive for some teams and need a later ADR or feature expansion

## Implementation Notes

Task 37 should align with this ADR by ensuring:

- PR creation starts from a dedicated working branch, not a direct base-branch push flow
- The UI asks for or derives a short kebab-case description before branch creation
- Branch-name conflicts produce a clear, actionable error instead of silent renaming
- The PR form defaults to ready-for-review while still allowing draft selection
- The backend resolves the repository default branch and validates that it is the PR base
- PR body generation checks for repository PR templates before using the fallback template

## Open Questions

- Whether later versions should support user-selected non-default base branches
- Whether the app should help users generate kebab-case branch descriptions from workspace or task text
- How to handle repositories with multiple PR templates or org-specific PR automation

## References

- [adrs/adr-0001-github-app-ownership-and-permissions.md](./adr-0001-github-app-ownership-and-permissions.md)
- [docs/github-workspaces.md](../docs/github-workspaces.md)
- [task_list.md](../task_list.md)

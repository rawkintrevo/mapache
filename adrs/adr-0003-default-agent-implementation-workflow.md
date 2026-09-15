# ADR-0003: Default Agent Implementation Workflow

- Status: Accepted
- Date: 2026-09-15
- Owners: Mapache Tools maintainers
- Related issue: #352

## Context

Mapache already creates a separate `mapache/*` automation branch for connected Pi sessions and publishes that branch as a pull request when the session exits. The seeded GitHub skill, however, previously treated issue-based work as opt-in: an implementation request without an issue number could proceed without creating an issue, while manual publication occurred only when separately requested. Repository-local agent instructions also did not define a general implementation lifecycle.

That gap made it unclear whether a request should create an issue, remain as loose worktree changes, be committed, or result in a pull request.

## Decision

Every actionable implementation request in a GitHub-backed repository uses this workflow by default:

1. Reuse a supplied issue, or inspect the scope, search for duplicates, and create a scoped issue before editing.
2. Work on a separate branch. In connected Mapache sessions, retain the runner-created `mapache/*` automation branch rather than replacing it with an issue-numbered branch.
3. Implement, document, and test the scoped change.
4. Create a local commit that references the issue.
5. Push the branch and open a pull request against `main`. Runner exit automation may perform those publication steps for the active session automation branch; otherwise the agent publishes and verifies the PR manually.

Explanations, investigations, reviews, and issue-only requests do not imply implementation and therefore do not automatically create issues or branches.

### Explicit hotfix/direct-main exception

If the user explicitly calls the implementation a `hotfix` or explicitly requests work `directly on main`, the agent:

1. Updates `main` using a fast-forward-only pull.
2. Implements, documents, and tests on `main`.
3. Commits and pushes `main` directly.
4. Does not create an issue, working branch, or pull request unless separately requested.

Urgency, task size, or the word "fix" alone does not activate this exception. The agent never force-pushes or bypasses branch protection.

## Relationship To ADR-0002

This decision complements ADR-0002. Normal PR-oriented work still uses a dedicated `mapache/*` working branch and targets the default branch. The explicit hotfix/direct-main path does not open a pull request, so it is outside ADR-0002's PR-oriented branch requirement.

## Consequences

### Positive

- Implementation requests have an auditable issue, commit, and pull request by default.
- Connected sessions preserve the existing automation branch lifecycle.
- Direct-to-main behavior requires unmistakable user authorization.
- Agents no longer leave normal completed work as unexplained loose worktree changes.

### Negative

- Small normal changes incur issue and PR overhead.
- Issue creation requires authenticated GitHub write access.
- Existing materialized skill copies are not automatically refreshed when the seeded skill changes.
- Hotfixes can still be rejected by branch protection, which must be treated as a blocker rather than bypassed.

## Implementation Notes

The canonical runtime policy lives in `session-runner/seeded-skills/mapache-github-issue/SKILL.md`. Repository-local behavior is reinforced by `AGENTS.md` and `.agents/skills/issue-workflow/SKILL.md`. Shipping the seeded skill update requires rebuilding the affected runner image and creating a new Cloud Run revision or session. Existing workspace copies require explicit refresh because skill materialization writes only missing files.

## References

- [ADR-0002: PR Creation and Branch Naming Policy](./adr-0002-pr-creation-and-branch-naming-policy.md)
- [GitHub workspaces](../docs/github-workspaces.md)

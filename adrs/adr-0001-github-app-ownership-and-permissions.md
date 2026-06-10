# ADR-0001: GitHub App Ownership, Permissions, and Repository Scope

- Status: Accepted
- Date: 2026-06-10
- Owners: Pi Agents Cloud maintainers
- Related tasks: Task 25 (Decide GitHub App ownership and permission policy)

## Context

The Pi Agents Cloud project needs a GitHub App to support private repository access, a connected repo picker, and pull request creation. Before creating the app or writing code that depends on its permissions, we must decide:

1. Who will own the GitHub App
2. What repository permissions it requires
3. Whether installations cover all repositories or only selected ones

These decisions affect security boundaries, user experience, and the complexity of later implementation.

## Decision

### Owner: Organization-owned app under `ata-systems`

The GitHub App will be owned by the `ata-systems` GitHub organization, not a personal account or a deployment-specific org.

**Rationale:**

- An organization-owned app survives personal account changes and team turnover
- `ata-systems` is the existing organizational home for this project
- Organization ownership allows multiple maintainers to manage the app without relying on one person's account
- Future transfer to a different org is possible without reinstalling on every user's repositories

### Permissions

| Permission | Level | Purpose |
|------------|-------|---------|
| Contents | Read & write | Clone private repos and push branches |
| Metadata | Read-only | List repositories and validate access |
| Pull requests | Read & write | Create and manage PRs |

No organization-level permissions are required.

User permissions:

| Permission | Level | Purpose |
|------------|-------|---------|
| Email addresses | Read-only | Link GitHub identity to app user identity |

**Rationale:**

- Contents read/write is the minimum permission set that supports clone, push, and branch creation
- Metadata read is required for repository listing and basic repository info
- Pull request read/write is required for PR creation
- No additional permissions (issues, actions, checks) are needed for the current scope
- Email read is needed for user identity mapping without exposing unnecessary data

### Repository Scope: All repositories

The app will be installable on **all repositories** the user has access to, not a pre-selected subset.

**Rationale:**

- Simpler UX: users do not need to revisit GitHub settings every time they create a new repository
- Reduces support burden from users who forgot to add a new repo to the app's scope
- The app already operates on a per-workspace basis, so the user controls which repo is used at workspace creation time
- If a need for repo-level restrictions emerges later, GitHub supports post-installation repository selection toggling

## Consequences

### Positive

- Organization ownership gives the project a stable, transferable identity
- The chosen permission set is the minimum viable set for planned features
- All-repositories scope reduces friction for users creating new repositories

### Negative

- Organization ownership means the app URL is tied to `ata-systems`; rebranding would require creating a new app
- All-repositories scope requires trust that the app will not act on repositories the user did not explicitly intend to use
- Contents read/write is a high-privilege permission; a compromised token could modify repository contents

### Risks

- Private key compromise would allow token minting for any installation
- Installation tokens must be short-lived and never stored in Firestore or Cloud Storage
- The backend must verify that the requesting user is the same user who authorized the installation

### Follow-up work

- Implement short-lived installation token creation (Task 32)
- Implement token pass-through to the runner without logging or storage (Task 35)
- Add installation-scoped repository listing (Task 33)
- Document token lifecycle and rotation procedures

## Security Notes

- The private key must be stored in Google Cloud Secret Manager or Firebase Functions secrets
- No secret values (private key, client secret, webhook secret) may be committed to this repository
- Installation tokens must be minted server-side, passed to the runner only for immediate use, and discarded afterward
- The runner must not write token values into `.git/config`, file sync state, or archive backups

## Operational Notes

- App creation requires an `ata-systems` organization owner or admin
- Changing permissions after creation requires re-authorization by all installations
- Webhook and callback URLs can be left blank initially and configured when backend routes exist

## Open Questions

- Whether to require two-factor authentication for app management access
- Whether to enable webhook delivery verification in production
- Whether to support multiple GitHub App installations per user account

## References

- [GitHub App permissions documentation](https://docs.github.com/en/rest/overview/permissions-required-for-github-apps)
- [GitHub App installation token docs](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
- [docs/guides/github-app-setup.md](../docs/guides/github-app-setup.md)

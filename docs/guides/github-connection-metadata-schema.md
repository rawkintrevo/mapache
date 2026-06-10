# GitHub Connection Metadata Schema

This guide defines the Firestore document shapes used for GitHub App-backed connections, connected repository selection, and later private-repo / PR flows.

## Goals

- Keep secret values out of Firestore
- Make ownership boundaries explicit
- Support repo picker and token minting without guessing
- Preserve the current public-URL GitHub workspace flow

## What Must Never Be Stored

Do **not** store any of the following in Firestore:

- GitHub App private key material
- installation access tokens
- user access tokens
- webhook secrets
- client secret values

Store those in Firebase Functions secrets or Google Cloud Secret Manager instead.

## Recommended Collection Layout

### `githubUsers/{firebaseUid}`

User-level GitHub connection record for the signed-in Pi user.

```js
{
  firebaseUid: "firebase-auth-uid",
  githubUserId: 12345678,
  githubLogin: "octocat",
  displayName: "Octo Cat",
  avatarUrl: "https://avatars.githubusercontent.com/u/12345678?v=4",
  connectionStatus: "connected", // connected | needs_reauth | disconnected
  installationIds: [123456],
  createdAt: Timestamp,
  updatedAt: Timestamp,
  lastSyncedAt: Timestamp
}
```

### `githubUsers/{firebaseUid}/installations/{installationId}`

Installation-level metadata for the current Pi user.

```js
{
  installationId: 123456,
  ownerUid: "firebase-auth-uid",
  githubAccountId: 87654321,
  githubAccountLogin: "ata-systems",
  githubAccountType: "Organization", // User | Organization
  repositorySelection: "all", // all | selected
  appId: 987654,
  permissionSet: {
    contents: "read/write",
    metadata: "read",
    pull_requests: "read/write"
  },
  installationStatus: "active", // active | suspended | removed | needs_reauth
  webhookConfigured: true,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  lastSyncedAt: Timestamp,
  removedAt: Timestamp|null
}
```

### `githubUsers/{firebaseUid}/installations/{installationId}/repositories/{repoId}`

Repository metadata available through a specific installation.

```js
{
  repoId: 11223344,
  installationId: 123456,
  ownerUid: "firebase-auth-uid",
  ownerLogin: "ata-systems",
  name: "example-repo",
  fullName: "ata-systems/example-repo",
  htmlUrl: "https://github.com/ata-systems/example-repo",
  cloneUrl: "https://github.com/ata-systems/example-repo.git",
  private: true,
  defaultBranch: "main",
  accessible: true,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  lastVerifiedAt: Timestamp
}
```

### `workspaces/{workspaceId}` source metadata

Workspace documents should keep only the source metadata needed to reconstruct and validate the workspace, not any secrets.

```js
source: {
  type: "github",
  mode: "connected", // public | connected
  repoUrl: "https://github.com/ata-systems/example-repo.git",
  owner: "ata-systems",
  repo: "example-repo",
  requestedBranch: "main",
  requestedCommit: null,
  resolvedBranch: "main",
  resolvedCommit: "abc123...",
  visibility: "private", // public | private
  connection: {
    installationId: 123456,
    repoId: 11223344,
    ownerUid: "firebase-auth-uid"
  },
  status: "ready", // pending | ready | clone_failed | sync_failed
  statusMessage: null
}
```

For public-URL workspaces, `mode` should be `public` and `connection` should be absent.

## Ownership Boundaries

- `githubUsers/{firebaseUid}` is owned by the Firebase auth UID
- installations and repos under that branch are readable/writable only by that same Firebase auth UID, unless the backend service account is performing a server-side operation
- workspace source metadata may reference installation/repo ids, but it must never contain tokens or secrets

## Permission Boundaries

The schema records permission intent, not token values.

Store only the access level needed to reason about behavior:

- `contents`: `read/write`
- `metadata`: `read`
- `pull_requests`: `read/write`

If the app later needs more GitHub permissions, add them explicitly here before implementation.

## Access Patterns

### Repo picker

The repo picker backend should read from the current user’s installation/repository branch and return only repositories that are accessible for that user.

### Clone / push / PR operations

These operations should:

1. read the workspace source metadata
2. verify the referenced installation/repo still exists
3. mint a short-lived installation token server-side
4. pass the token only for the immediate operation
5. discard the token afterward

### Cleanup / revocation

If an installation is removed or revoked:

- update `installationStatus` to `removed` or `needs_reauth`
- stop presenting repositories from that installation in the picker
- avoid deleting workspace source metadata unless the workspace is explicitly migrated

## Security Notes

- Never store installation tokens in Firestore
- Never store GitHub App private key material in Firestore
- Never write token values into logs, sync archives, or file browser state
- Prefer server-side verification of installation ownership before any token minting

## Related Documents

- [GitHub App setup guide](github-app-setup.md)
- [GitHub App ownership ADR](../../adrs/adr-0001-github-app-ownership-and-permissions.md)
- [GitHub workspace design](../github-workspaces.md)

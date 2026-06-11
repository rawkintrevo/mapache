# Pi Extension Manager

This document describes the intended architecture for a browser-based extension manager for Pi-based runner sessions.

The feature is intentionally additive. Pi already has package management through its TUI and CLI. Mapache should provide a web surface over the same workspace-local files and package behavior, not replace the tools available inside the terminal.

## Goals

The extension manager should:

- Let users inspect Pi packages configured for the active workspace.
- Let users install, remove, and update Pi packages from the web UI.
- Default to workspace-local package installs, equivalent to `pi install -l ...`.
- Reflect packages installed directly in Pi with `pi install -l ...` after refresh.
- Remember packages a user has used across workspaces without installing them everywhere.
- Offer known packages for installation into another workspace with an explicit install action.
- Keep package code out of the browser and client device.
- Reuse existing runner and Cloud Storage persistence patterns for high-cardinality install directories.

The first implementation can require an active `pi-basic` session. Package operations are runtime operations: they can need npm, git, workspace trust, network access, and the same local filesystem state Pi sees inside the session. A live runner is the simplest correct execution boundary for v1.

## Non-Goals

The v1 manager should not:

- Replace Pi's TUI package screens or CLI commands.
- Install packages globally by default.
- Install a user's known packages into every workspace automatically.
- Store package source code or package tarballs in Firestore.
- Write package code to the browser or client device.
- Expose arbitrary command execution through package APIs.
- Treat Cloud Storage as a package registry.

## Pi Package Scopes

Pi supports user and project-local package configuration. The web extension manager should default to project-local configuration.

### Workspace-Local Packages

Workspace-local package declarations live at:

```text
/workspace/.pi/settings.json
```

When a user runs this inside the terminal:

```bash
pi install -l npm:@foo/bar
pi install -l git:github.com/user/repo
```

Pi writes package source entries to `/workspace/.pi/settings.json` and installs package code under the workspace's `.pi` directory. The web manager should read the same settings file through Pi-compatible package logic, so terminal-installed packages appear after a refresh.

Installed package code lives under:

```text
/workspace/.pi/npm/
/workspace/.pi/git/
```

These directories are workspace runtime cache state, not the portable package declaration. They can contain many files and should be handled like other high-cardinality runtime directories.

### User-Scoped Pi Packages

If a user runs `pi install` without `-l`, Pi writes to user-scoped settings under the Pi home directory:

```text
/root/.pi/agent/settings.json
/root/.pi/agent/npm/
/root/.pi/agent/git/
```

Mapache already persists `/root/.pi` as a user-scoped archive so Pi auth and user-level state can follow the authenticated user across workspaces. The web manager should not make this scope the default install target.

The UI may later show user-scoped packages in a separate section. A user-scoped package should not be presented as installed for the current workspace unless it is also configured in `/workspace/.pi/settings.json`. The useful action is to install the same source workspace-locally.

## Source of Truth

The manager has two source-of-truth layers.

### Current Workspace

The current workspace source of truth is `/workspace/.pi/settings.json`.

This file declares which Pi packages the workspace wants. It should remain a normal workspace file:

- It can be synced as an ordinary Cloud Storage object.
- It can appear in the Files UI when present.
- In a GitHub workspace, the user can commit it if they want team-shared package configuration.

The web manager must refresh from the runner instead of trusting stale frontend state. That ensures changes made from the Pi terminal are visible in the browser.

### User Package Catalog

The cross-workspace package memory belongs in Firestore under the authenticated user. It records package sources the user has used or observed, not installed code.

Suggested path:

```text
users/{uid}/piPackageCatalog/{encodedPackageIdentity}
```

The document id is a URL-encoded form of the derived identity so git identities can contain `/` while the stored `identity` field remains readable.

Suggested fields:

```js
{
  source: "npm:@foo/bar@1.2.3",
  identity: "npm:@foo/bar",
  type: "npm",
  createdAt: Timestamp,
  updatedAt: Timestamp,
  installCount: 3,
  lastWorkspaceId: "workspace-id",
  favorite: false
}
```

The exact `source` string should be preserved because pinned npm versions and pinned git refs affect behavior. The derived `identity` is for grouping and deduplication. For example, `npm:@foo/bar` and `npm:@foo/bar@1.2.3` are related but not identical install requests.

The catalog lets the UI show "known but not installed in this workspace" packages with an `Install` action. Catalog entries must not cause automatic installation into new workspaces. Read-only package listing may observe the active workspace's configured packages and merge those sources into this catalog; catalog write failures should be logged but should not break the package list response.

## Write Locations

This section lists every place the extension manager is expected to write.

### Running Cloud Run Session Filesystem

The runner writes package declarations and installed code inside the active session:

```text
/workspace/.pi/settings.json
/workspace/.pi/npm/
/workspace/.pi/git/
```

The runner may also observe user-scoped Pi package state here:

```text
/root/.pi/agent/settings.json
/root/.pi/agent/npm/
/root/.pi/agent/git/
```

For workspace-local web operations, `/workspace/.pi/...` is the target. `/root/.pi/...` remains available for Pi's existing user-scoped tooling but is not the default web manager target.

### Cloud Storage

Workspace-local package declarations are synced as normal workspace files:

```text
{workspace.storagePrefix}/.pi/settings.json
```

Workspace-local installed package code should be archived instead of synced object-by-object:

```text
{workspace.storagePrefix}/.mapahce-internal/archives/workspace-pi-npm.tar.gz
{workspace.storagePrefix}/.mapahce-internal/archives/workspace-pi-git.tar.gz
```

An implementation may choose a single combined archive, such as `workspace-pi-packages.tar.gz`, if that proves simpler. Separate archives make npm and git cache behavior easier to reason about.

The existing user Pi home archive remains:

```text
users/{uid}/.mapahce-internal/pi-home/root-pi.tar.gz
```

The workspace package manager should not use this user archive as its primary write path. It changes when Pi itself writes user-scoped state or when the user runs non-local package commands.

### Firestore

The package catalog is user-scoped:

```text
users/{uid}/piPackageCatalog/{packageIdentity}
```

If synchronous runner calls are not sufficient for install/remove/update UX, package operation status can be persisted under the workspace or session:

```text
workspaces/{workspaceId}/extensionOperations/{operationId}
```

or:

```text
workspaces/{workspaceId}/sessions/{sessionId}/extensionOperations/{operationId}
```

Suggested operation fields:

```js
{
  action: "install",
  source: "npm:@foo/bar",
  status: "running",
  startedAt: Timestamp,
  completedAt: null,
  error: null
}
```

Operation records are optional for v1. If runner calls return promptly enough and the frontend does not need reload recovery for in-flight installs, operation status can remain ephemeral.

### Browser / Client Device

The browser should not store package code, package archives, or package credentials.

Client-side writes should be limited to normal app state:

- Firebase Auth state managed by Firebase.
- In-memory UI state such as selected tab, form input, and loading state.
- Existing local UI preferences if the app already uses local storage for them.

Package metadata that needs to persist across sessions belongs in Firestore, not browser local storage.

## Runner API Shape

The runner should expose protected package endpoints using the same shutdown token gate as existing protected runner endpoints.

Initial endpoints:

```text
GET  /pi/packages
POST /pi/packages/install
POST /pi/packages/remove
POST /pi/packages/update
```

The initial list endpoint returns workspace-local configured packages from `/workspace/.pi/settings.json` and a stable empty `packages: []` array when the settings file is absent or contains no packages. User-scoped packages can be added later in a separate section:

```js
{
  ok: true,
  scope: "workspace",
  settingsPath: "/workspace/.pi/settings.json",
  packages: [
    {
      source: "npm:@foo/bar",
      scope: "workspace",
      type: "npm",
      filtered: false,
      installedPath: "/workspace/.pi/npm/node_modules/@foo/bar"
    }
  ],
  knownPackages: [
    {
      source: "npm:@org/previous-tool",
      identity: "npm:@org/previous-tool",
      type: "npm",
      favorite: false
    }
  ]
}
```

Mutating endpoints should default to workspace-local behavior. Runner install support uses `pi install -l <source>` from `/workspace` for npm/git sources, and runner remove support uses `pi remove -l <source>`. Both force normal workspace sync plus package cache archive upload so `/workspace/.pi/settings.json`, `/workspace/.pi/npm`, and `/workspace/.pi/git` persist. Update should follow Pi package update semantics.

When practical, the runner should use Pi's exported package manager APIs rather than parsing CLI output. CLI fallback is acceptable if the package manager API is not available in the installed runtime, but the web API should still return structured responses.

## Backend API Shape

Cloud Functions should expose authenticated `/api/**` routes that proxy package operations to an active runner. Initial package routes are:

```text
GET  /api/workspaces/{workspaceId}/sessions/{sessionId}/pi-packages
POST /api/workspaces/{workspaceId}/sessions/{sessionId}/pi-packages/install
POST /api/workspaces/{workspaceId}/sessions/{sessionId}/pi-packages/remove
```

The backend is responsible for:

- Verifying Firebase Auth.
- Verifying workspace ownership.
- Verifying session ownership under the workspace.
- Finding a live runner `serviceUrl`.
- Sending the runner shutdown token.
- Validating package source strings before mutating operations.
- Updating the user package catalog after successful installs or observed package listings.
- Returning stable error codes for the frontend.

Expected error cases:

- No active session is selected or available.
- The selected session is not running.
- The runner does not support package endpoints.
- The runner is temporarily unavailable.
- The package source is invalid or unsupported.
- The package operation is already busy.
- The package manager failed safely with a displayable error.

## Frontend Behavior

The right drawer already reserves an `Extensions` section. That section should become the package manager surface.

The v1 panel should show:

- Workspace-local packages configured for the active workspace.
- Known user packages not installed in the active workspace.
- A compact install form that accepts npm and git package sources.
- Refresh, loading, empty, unavailable, busy, success, and error states.
- Install actions for known packages.
- Remove/update actions for workspace-local packages when supported.

The UI should explicitly preserve the relationship with Pi tooling:

- Terminal/TUI installs are still valid.
- A refresh reads the same workspace-local Pi settings.
- User-scoped packages are separate from workspace-local packages.

The panel should not become a general shell command runner. Inputs should be package source strings, not arbitrary commands.

## Sync and Archive Rules

The package manager should reuse the runner's existing archive-backed sync pattern.

Normal file sync:

- Sync `/workspace/.pi/settings.json`.
- Do not sync `/workspace/.pi/npm/` object-by-object.
- Do not sync `/workspace/.pi/git/` object-by-object.
- Do not expose internal archive paths through Files UI or editor routes.

Archive sync:

- Restore package cache archives before serving package status when possible.
- Upload package cache archives on the slower archive interval.
- Upload package cache archives during protected shutdown sync.
- Keep existing archive targets for `/workspace/node_modules`, `/workspace/.git`, and `/root/.pi` intact.

For GitHub workspaces, `.pi/settings.json` belongs to the working tree. The package install cache is local runtime state. Users can choose to commit `.pi/settings.json`, but package cache archives should remain hidden internal state.

## Concurrency

Package operations should be serialized in the runner.

Reasons:

- Pi TUI/CLI and the web manager can both modify `.pi/settings.json`.
- npm and git package installs can modify package cache directories.
- Archive upload may run while package directories are changing.

The first implementation uses an in-memory runner lock. Mutating web operations should fail with a stable `package_operation_busy` response when another package operation is running. Read/list operations wait for the current lock and then run under the same lock so package settings and cache paths are read consistently.

The lock does not prevent a user from running `pi install -l ...` manually in the terminal at the exact same time. The web manager still needs to recover by refreshing from disk and returning safe errors if Pi package settings are temporarily inconsistent.

## Security

Pi packages can execute arbitrary code as part of package behavior and loaded extensions. The manager should treat package installation as a privileged runtime action.

Security expectations:

- Require authenticated backend routes.
- Verify workspace/session ownership before proxying to a runner.
- Use the runner's protected token gate for package endpoints.
- Validate package source syntax and reject unsupported source types.
- Do not accept arbitrary shell commands.
- Do not log credentials or token-bearing URLs.
- Prefer npm and git source support in v1; local path support should be considered separately.
- Preserve exact source strings for auditability and repeatability.

Git package auth needs special care. HTTPS and SSH sources may rely on credentials already available inside the runner. The web UI should not ask users to paste secrets into package source strings.

## Open Implementation Decisions

These decisions can be resolved during the relevant implementation tasks:

- Whether package cache archives should be one combined archive or separate npm/git archives.
- Whether package operations should be fully synchronous or backed by Firestore operation records.
- Whether the runner can reliably import Pi's package manager API in the installed `pi-basic` image, or whether CLI fallback is needed.
- How much user-scoped package detail to expose in the first frontend version.
- Whether `.pi/settings.json` should be hidden by default in the Files UI or shown as normal project configuration.

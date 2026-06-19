# Session Runner Architecture

## Purpose

This page maps the runner server modules. Detailed runtime behavior remains in [runtime-containers.md](./runtime-containers.md).

## Read When

Read this before changing `session-runner/server.js`, PTY/WebSocket behavior, preview serving, workspace sync, Git commands, Pi skills/packages, or runner validation helpers.

## Canonical Owner

- Entrypoint/router: `session-runner/server.js`
- Shared config: `session-runner/lib/config.js`
- Terminal and PTY: `session-runner/lib/terminal.js`
- Preview gateway: `session-runner/lib/preview.js`
- Workspace restore/sync: `session-runner/lib/workspace.js`
- Workspace archives: `session-runner/lib/workspaceArchives.service.js`
- GitHub workspace reconstruction: `session-runner/lib/workspaceGithub.service.js`
- Pi auth materialization: `session-runner/lib/workspacePiAuth.service.js`
- Git endpoints: `session-runner/lib/git.js` and `git*.service.js`
- Pi endpoints: `session-runner/lib/pi.js`, `piPackage.service.js`, `piSkill.service.js`
- Harness-neutral seeded skill catalog and profiles: `session-runner/lib/workspaceSkillCatalog.js` and `session-runner/seeded-skills/`
- Codex workspace guidance and native skill materialization: `session-runner/lib/codex.js`, `session-runner/lib/codexSeededWorkspace.service.js`, and `session-runner/seeded-codex/AGENTS.md`

## Current Behavior

`server.js` bootstraps Express, configures route gates, restores workspace state, starts the terminal process, and wires terminal/preview/Git/Pi routes. Feature behavior lives under `session-runner/lib/` so route paths and environment contracts stay stable while internals evolve.

The terminal uses `node-pty` and WebSocket replay. Preview routes support static, proxy, and N64 ROM modes depending on runner capabilities and workspace preview config. GitHub workspaces restore `.git` through archives or clone fallback, then restore worktree/cache state. Pi package and skill endpoints operate on the same `/workspace/.pi` files that Pi uses in the terminal.

Pi and Codex runners select the same harness-neutral `github`, `web`, and `n64` skill profiles from workspace source mode and runner capabilities. Pi materializes selected catalog entries under `.pi/skills/**`; Codex materializes the same source files under `.agents/skills/**`. Both paths preserve existing user-edited files. Codex also copies missing user-created Pi skills from `.pi/skills/**` into `.agents/skills/**` with Codex-compatible frontmatter.

## Invariants

- Browser terminal/preview/capability routes require browser-access tokens.
- Backend-only runner routes require the separate shutdown token.
- Tokens must not be persisted into workspace files, archives, or logs.
- High-cardinality caches such as `.git`, `node_modules`, `/root/.pi`, and Pi package code use archive-backed sync rather than normal file listing.
- Skills are small Markdown workspace files and remain normal sync state.

## Verification

- `npm --prefix session-runner run lint`
- `npm --prefix session-runner test` for touched helper/service behavior when feasible.
- Runtime image changes need a Cloud Build push and note whether existing Cloud Run services require recreation or a new revision.

## Last Verified Assumptions

- 2026-06-17: Runner modules listed above exist under `session-runner/lib/`.

## Related Docs

- [Runtime containers](./runtime-containers.md)
- [GitHub workspaces](./github-workspaces.md)
- [Pi skills manager](./pi-skills-manager.md)
- [Pi extension manager](./pi-extension-manager.md)

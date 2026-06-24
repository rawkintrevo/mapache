# Session Runner Architecture

## Purpose

This page maps the runner server modules. Detailed runtime behavior remains in [runtime-containers.md](./runtime-containers.md).

## Read When

Read this before changing `session-runner/server.js`, PTY/WebSocket behavior, preview serving, workspace sync, Git commands, Pi skills/packages, or runner validation helpers.

## Canonical Owner

- Entrypoint/router: `session-runner/server.js`
- Browser QA orchestration: `session-runner/lib/browserQa.js` and `session-runner/bin/mapache-preview-qa.js`
- Shared config: `session-runner/lib/config.js`
- Harness metadata and startup hooks: `session-runner/lib/harnesses/`
- Terminal and PTY: `session-runner/lib/terminal.js`
- Preview gateway: `session-runner/lib/preview.js`
- Workspace restore/sync: `session-runner/lib/workspace.js`
- Workspace archives: `session-runner/lib/workspaceArchives.service.js`
- GitHub workspace reconstruction: `session-runner/lib/workspaceGithub.service.js`
- Harness-backed auth materialization: `session-runner/lib/workspaceAuth.service.js`, `session-runner/lib/workspacePiAuth.service.js`
- Git endpoints: `session-runner/lib/git.js` and `git*.service.js`
- Pi/package/workspace-skill/subagent endpoints: `session-runner/lib/pi.js`, `piPackage.service.js`, `workspaceSkill.service.js`, `piSkill.service.js`, `workspaceSubagent.service.js`
- Harness-neutral seeded skill catalog and profiles: `session-runner/lib/workspaceSkillCatalog.js` and `session-runner/seeded-skills/`
- Codex workspace guidance and native skill materialization: `session-runner/lib/codex.js`, `session-runner/lib/codexSeededWorkspace.service.js`, and `session-runner/seeded-codex/AGENTS.md`

## Current Behavior

`server.js` bootstraps Express, configures route gates, restores workspace state, starts the terminal process, and wires terminal/preview/Git/Pi routes. Feature behavior lives under `session-runner/lib/` so route paths and environment contracts stay stable while internals evolve. Harness resolution now happens once at startup through `createRunnerHarnessRegistry()`, which provides ordered hooks for config, auth, MCP, seeded skills, and future harness-specific initialization.

The protected `POST /workspace/sync-down` route lets Functions ask a running cloud session to pull workspace files from Cloud Storage into the live workspace directory after browser-side file writes. This keeps the file browser and terminal pointed at the same workspace without waiting for a later runner restart.

The terminal uses `node-pty` and WebSocket replay. The terminal iframe HTML in `terminal.js` also inlines the critical xterm layout rules that visually hide the helper textarea and anchor the viewport/screen, then reapplies visual-only helper-textarea styles after render. Do not force the helper textarea offscreen, zero-size it, or clear its value from wrapper code; xterm's mobile soft-keyboard and composition handling depends on owning that internal state. Preview routes support static, proxy, and N64 ROM modes depending on runner capabilities and workspace preview config. Web-capable images also expose a runner-owned browser QA contract: `browserQa.js` reports dependency health into `/capabilities`, `/preview/status`, and `/preview/qa/status`, while the image-local `mapache-preview-qa` command launches Chromium through Playwright, writes structured reports under `$MAPACHE_QA_DIR`, and updates a shared `last-run.json` state file that status routes can surface. GitHub workspaces restore `.git` through archives or clone fallback, then restore worktree/cache state. Pi package and skill endpoints operate on the same `/workspace/.pi` files that Pi uses in the terminal.

Pi and Codex runners select the same harness-neutral `github`, `web`, and `n64` skill profiles from workspace source mode and runner capabilities. Pi materializes selected catalog entries under `.pi/skills/**`; Codex materializes the same source files under `.agents/skills/**`. Both paths preserve existing user-edited files. Codex also copies missing user-created Pi skills from `.pi/skills/**` into `.agents/skills/**` with Codex-compatible frontmatter.

Workspace skill CRUD now uses neutral runner routes at `/skills` and `/skills/delete`. `workspaceSkill.service.js` resolves the active harness from `config.harnessId`, returns harness metadata and restart guidance with list/save/delete results, and keeps Pi legacy flat-file deletion support for historical `.pi/skills/{name}.md` entries. `server.js` still serves `/pi/skills*` aliases for rollout compatibility.

Workspace auth materialization now uses `workspaceAuth.service.js`, which reads user credentials from Firestore, applies the session's `authSelection`, and writes either Pi `auth.json` or Codex `auth.json` depending on the active harness. Runner routes expose the neutral `POST /auth/materialize` endpoint with a `/pi/auth/materialize` alias.

Workspace subagent CRUD now uses neutral runner routes at `/subagents` and `/subagents/delete`. Pi stores Markdown subagents under `.pi/agents/*.md`; Codex stores TOML subagents under `.codex/agents/*.toml`. Chain listing exists at `/subagent-chains`, but chain writes remain intentionally unsupported in V1.

## Invariants

- Browser terminal/preview/capability routes require browser-access tokens.
- Browser QA artifacts and state must stay under `$MAPACHE_QA_DIR`; status routes read that state instead of scraping terminal output.
- Backend-only runner routes require the separate shutdown token.
- Tokens must not be persisted into workspace files, archives, or logs.
- High-cardinality caches such as `.git`, `node_modules`, `/root/.pi`, and Pi package code use archive-backed sync rather than normal file listing.
- Skills are small Markdown workspace files and remain normal sync state.
- Harness-specific workspace files such as `.codex/config.toml`, `.codex/agents/*.toml`, and `.pi/agents/*.md` remain visible workspace state, not hidden archive state.

## Verification

- `npm --prefix session-runner run lint`
- `npm --prefix session-runner test` for touched helper/service behavior when feasible.
- Runtime image changes need a Cloud Build push and note whether existing Cloud Run services require recreation or a new revision.

## Last Verified Assumptions

- 2026-06-17: Runner modules listed above exist under `session-runner/lib/`.

## Related Docs

- [Runtime containers](./runtime-containers.md)
- [Runner harnesses](./runner-harnesses.md)
- [GitHub workspaces](./github-workspaces.md)
- [Pi skills manager](./pi-skills-manager.md)
- [Pi extension manager](./pi-extension-manager.md)

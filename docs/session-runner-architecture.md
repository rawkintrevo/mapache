# Session Runner Architecture

## Purpose

This page maps the runner server modules. Detailed runtime behavior remains in [runtime-containers.md](./runtime-containers.md).

## Read When

Read this before changing `session-runner/server.js`, PTY/WebSocket behavior, preview serving, workspace sync, Git commands, Pi skills/packages, or runner validation helpers.

## Canonical Owner

- Entrypoint/composition root: `session-runner/server.js`
- HTTP route registrars: `session-runner/routes/browserPreviewRoutes.js`, `sshRoutes.js`, `workspaceRoutes.js`, `agentRoutes.js`, and `gitRoutes.js`
- Startup/shutdown coordination: `session-runner/lib/runnerLifecycle.js`
- Browser QA orchestration: `session-runner/lib/browserQa.js` and `session-runner/bin/mapache-preview-qa.js`
- Shared config: `session-runner/lib/config.js`
- Harness metadata and startup hooks: `session-runner/lib/harnesses/`
- Terminal and PTY: `session-runner/lib/terminal.js`
- Preview gateway: `session-runner/lib/preview.js`
- Workspace restore/sync: `session-runner/lib/workspace.js`
- Workspace archives: `session-runner/lib/workspaceArchives.service.js`
- Chrome desktop/profile/access: `session-runner/lib/chromeDesktop.js`, `chromeRuntime.js`, `chromeProfile.service.js`, `chromeProfileSnapshot.service.js`, `browserAccess.js`, and `vncBridge.js`
- Chrome harness integration: `session-runner/lib/mcpConfig.service.js`, `browserQa.js`, `workspaceSkillCatalog.js`, `seeded-skills/mapache-chrome/`, and `bin/mapache-chrome-status.js`
- GitHub workspace reconstruction: `session-runner/lib/workspaceGithub.service.js`
- Harness-backed auth materialization: `session-runner/lib/workspaceAuth.service.js`, `session-runner/lib/workspacePiAuth.service.js`
- Git endpoints: `session-runner/lib/git.js` and `git*.service.js`
- Pi/package/workspace-skill/subagent endpoints: `session-runner/lib/pi.js`, `piPackage.service.js`, `workspaceSkill.service.js`, `piSkill.service.js`, `workspaceSubagent.service.js`
- Harness-neutral seeded skill catalog and profiles: `session-runner/lib/workspaceSkillCatalog.js` and `session-runner/seeded-skills/`
- Codex workspace guidance and native skill materialization: `session-runner/lib/codex.js`, `session-runner/lib/codexSeededWorkspace.service.js`, and `session-runner/seeded-codex/AGENTS.md`

## Current Behavior

`server.js` bootstraps Express, constructs the shared services and HTTP/WebSocket servers, delegates route registration to focused modules, and wires the shared upgrade dispatcher. `runnerLifecycle.js` owns the ordered workspace restore, Chrome startup, harness materialization, Git automation setup, snapshot startup, sync-loop startup, and server listen sequence. It also owns shutdown ordering so SSH forwards close before the final profile/archive snapshot and activity update. Startup rejects before the listen step when any preparation step fails. Feature behavior lives under `session-runner/lib/` so route paths and environment contracts stay stable while internals evolve. Harness resolution now happens once at startup through `createRunnerHarnessRegistry()`, which provides ordered hooks for config, auth, MCP, seeded skills, and future harness-specific initialization. Route registrars receive their service dependencies explicitly; they do not create a second server or own startup lifecycle.

The protected `POST /workspace/sync-down` route lets Functions ask a running cloud session to pull workspace files from Cloud Storage into the live workspace directory after browser-side file writes. This keeps the file browser and terminal pointed at the same workspace without waiting for a later runner restart. File listing is intentionally lazy: Cloud Storage-backed listings are directory-scoped through the Functions API, and SSH-backed listings flow through `/ssh/files?path=...` so the runner inspects only the requested remote directory.

The terminal uses `node-pty` and WebSocket replay. `webSocketUpgrade.js` is the single HTTP upgrade dispatcher: both terminal and browser WebSocket servers use `noServer` mode, then the dispatcher routes `/terminal` and authenticated `/browser/vnc` requests explicitly. Do not attach a path-scoped `WebSocketServer` directly to the shared HTTP server; its automatic upgrade listener rejects other valid WebSocket paths before their handlers run. The terminal iframe HTML in `terminal.js` also inlines the critical xterm layout rules that visually hide the helper textarea and anchor the viewport/screen, then reapplies visual-only helper-textarea styles after render. Do not force the helper textarea offscreen, zero-size it, or clear its value from wrapper code; xterm's mobile soft-keyboard and composition handling depends on owning that internal state. Preview routes support static, proxy, and N64 ROM modes depending on runner capabilities and workspace preview config. Web-capable images also expose a runner-owned browser QA contract: `browserQa.js` reports dependency health into `/capabilities`, `/preview/status`, and `/preview/qa/status`, while the image-local `mapache-preview-qa` command launches Chromium through Playwright, writes structured reports under `$MAPACHE_QA_DIR`, and updates a shared `last-run.json` state file that status routes can surface. GitHub workspaces restore `.git` through archives or clone fallback, then restore worktree/cache state. Pi package and skill endpoints operate on the same `/workspace/.pi` files that Pi uses in the terminal.

Pi and Codex runners select the same harness-neutral `github`, `web`, `n64`, and `mapache-chrome` skill profiles from workspace source mode and runner capabilities. Pi materializes selected catalog entries under `.pi/skills/**`; Codex materializes the same source files under `.agents/skills/**`. Both paths preserve existing user-edited files. Codex also copies missing user-created Pi skills from `.pi/skills/**` into `.agents/skills/**` with Codex-compatible frontmatter.

For Chrome images, startup restores the sanitized workspace-owned profile archive before starting Xvfb, openbox, tint2, Chromium, and x11vnc. Chromium binds CDP and x11vnc to `127.0.0.1`; the runner exposes only authenticated `/browser/`, `/browser/status`, `/browser/activity`, and `/browser/vnc` surfaces. Browser access uses a secure, HTTP-only, same-site-none partitioned cookie so noVNC assets remain authorized when the runner is embedded cross-site and unpartitioned third-party cookies are blocked. The noVNC redirect also includes the signed, short-lived browser token in its nested WebSocket path; the existing no-referrer response policy prevents that URL from being sent as a referrer. The Chrome image build patches Debian's noVNC settings adapter to fall back to its page-local settings cache when embedded-frame storage is unavailable, because an uncaught `localStorage` security error otherwise prevents noVNC initialization. `browserQa.js` attaches with Playwright `connectOverCDP`, creates and closes only its own QA page, and leaves the shared browser and user tabs running. Periodic and final profile snapshots are serialized with shutdown and exclude caches, crash data, downloads, lock files, and other transient state.

Workspace skill CRUD now uses neutral runner routes at `/skills` and `/skills/delete`. `workspaceSkill.service.js` resolves the active harness from `config.harnessId`, returns harness metadata and restart guidance with list/save/delete results, and keeps Pi legacy flat-file deletion support for historical `.pi/skills/{name}.md` entries. `server.js` still serves `/pi/skills*` aliases for rollout compatibility.

Workspace auth materialization now uses `workspaceAuth.service.js`, which reads user credentials from Firestore, applies the session's `authSelection`, and writes either Pi `auth.json` or Codex `auth.json` depending on the active harness. Runner routes expose the neutral `POST /auth/materialize` endpoint with a `/pi/auth/materialize` alias.

Workspace subagent CRUD now uses neutral runner routes at `/subagents` and `/subagents/delete`. Pi stores Markdown subagents under `.pi/agents/*.md`; Codex stores TOML subagents under `.codex/agents/*.toml`. Chain listing exists at `/subagent-chains`, but chain writes remain intentionally unsupported in V1.

## Invariants

- Browser terminal/preview/capability routes require browser-access tokens.
- The shared HTTP server has exactly one WebSocket upgrade dispatcher; terminal and browser WebSocket servers stay in `noServer` mode so neither can reject the other's path.
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
- [Frontend/Functions/runner compatibility matrix](./guides/frontend-functions-runner-compatibility.md)

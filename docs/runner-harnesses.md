# Runner Harnesses

## Purpose

This page owns the first-class harness interface that sits above runner images and below feature-specific frontend, Functions, and runner code.

## Read When

Read this before changing session image selection, persisted session metadata, auth materialization, workspace skills, MCP materialization, workspace subagents, or harness-gated inspector UI.

## Canonical Owner

- Shared frontend and Functions catalog: `functions/runnerCatalog.json`
- Frontend harness utilities: `src/utils/sessionHarnesses.js`
- Functions catalog helpers: `functions/runnerCatalog.helpers.js`, `functions/runnerImages.helpers.js`
- Functions session creation and env wiring: `functions/index.js`, `functions/cloudRun.service.js`
- Runner harness metadata and bootstrap: `session-runner/lib/harnesses/metadata.js`, `session-runner/lib/harnesses/index.js`
- Runner harness-backed services: `session-runner/lib/workspaceAuth.service.js`, `session-runner/lib/workspaceSkill.service.js`, `session-runner/lib/workspaceSubagent.service.js`

## Current Behavior

Mapache now persists a `harnessId` on each session document. `harnessId` is the stable feature contract. `imageKey` selects a curated runner image, and `terminalKind` remains the process/runtime hint used by older code paths and mixed deploys.

The supported harness ids are:

- `shell`
- `ssh`
- `pi`
- `codex`

The shared catalog in `functions/runnerCatalog.json` is the source of truth for frontend session pickers and Functions-side image resolution. Each image entry names a `harnessId`, stable `imageKey`, image URI, and preview/function/N64/Chrome capability flags. `pi-chrome` and `codex-chrome` retain the `pi` and `codex` harness ids while adding the `chrome` capability. Each harness entry declares whether it supports:

- auth materialization
- workspace-local skills
- MCP materialization
- workspace subagents
- workspace-local packages

The runner cannot import `functions/runnerCatalog.json` directly because the Docker build context is only `session-runner/`. Runner-local harness metadata therefore lives in `session-runner/lib/harnesses/metadata.js` and must stay behaviorally aligned with the shared catalog.

## Auth

Saved user credentials live in `users/{uid}/private/agentAuth`. Functions and runners read and write this canonical document directly; the native provider map inside it retains the harness file shape needed for Pi and Codex materialization.

Session-specific selection now lives on the session document as:

```text
authSelection
authSelectionUpdatedAt
```

`authSelection` stores both the target harness and the chosen entry ids per provider. Runners read this canonical field when materializing selected credentials. The web app and Functions expose neutral auth routes:

```text
GET  /api/auth
PUT  /api/auth/providers/{provider}
DELETE /api/auth/providers/{provider}
DELETE /api/auth/entries/{entryId}
POST /api/workspaces/{workspaceId}/sessions/{sessionId}/auth-selection
```

Legacy `/api/pi-auth/*` aliases still exist for rollout compatibility.

Pi sessions materialize the selected agent providers into `$HOME/.pi/agent/auth.json`. Codex sessions materialize the selected Codex providers into `$CODEX_HOME/auth.json`. Codex auth supports the OpenAI API key provider plus the OpenAI Codex OAuth token shape used by the local CLI. The runner writes current Codex auth-mode values (`chatgpt` and `apikey`) and skips materializing saved Codex OAuth credentials that do not include a valid JWT-shaped `id_token`, so a stale or partial saved credential cannot prevent the Codex CLI from starting.

GitHub CLI auth is a shared auth provider for Pi and Codex harnesses. The saved provider key is `github-cli`, stored as an API-key credential containing a GitHub token. It is not written into Pi or Codex native auth files. Instead, the runner materializes the selected token to `$HOME/.config/gh/hosts.yml` and excludes that file from the persistent `$HOME` archive. This makes the Authentication Center the durable source of truth for `gh` credentials while keeping manual `gh auth login` state session-local unless the user saves the token in the app.

## Skills, MCP, and Subagents

Harness metadata also drives workspace-local file locations:

- Pi skills: `.pi/skills/{name}/SKILL.md`
- Codex skills: `.agents/skills/{name}/SKILL.md`
- Pi subagents: `.pi/agents/{name}.md`
- Codex subagents: `.codex/agents/{name}.toml`

Those first two paths are the writable roots used by the web manager. Inspector listing is broader and recursive so it matches local harness discovery: Pi also reads workspace and user `.agents/skills` plus `~/.pi/agent/skills`, while Codex also reads `$CODEX_HOME/skills` and user `~/.agents/skills`. Alternate-root and user-local rows are visible as discovered but remain read-only in the workspace manager.

Neutral runner routes now cover both supported harnesses:

```text
GET  /skills
POST /skills
POST /skills/delete
GET  /subagents
POST /subagents
POST /subagents/delete
GET  /subagent-chains
POST /subagent-chains
POST /subagent-chains/delete
POST /auth/materialize
```

Legacy `/pi/skills*` and `/pi/auth/materialize` aliases remain available. Subagent chain listing exists for both harnesses, but write/delete is intentionally unsupported in V1 and returns a runner error.

Both Pi and Codex runners still write shared workspace MCP config to `/workspace/.mcp.json`. Codex additionally writes harness-specific config to `/workspace/.codex/config.toml`, not `$CODEX_HOME/config.toml`.

## Provisioning And Startup

Functions resolves the selected image to a harness before provisioning Cloud Run. The runner environment now includes:

- `HARNESS_ID`
- `TERMINAL_KIND`
- `CODEX_CONFIG_PATH=/workspace/.codex/config.toml` for Codex sessions
- Chrome-only connection guidance: `MAPACHE_BROWSER_CDP_URL`, `MAPACHE_BROWSER_STATUS_URL`, `MAPACHE_BROWSER_ACTIVITY_URL`, and `MAPACHE_BROWSER_STATUS_COMMAND`.

Runner startup now resolves the active harness once, then executes harness hooks in order:

1. `materializeConfig`
2. `materializeAuth`
3. `materializeMcp`
4. `materializeSkills`
5. `materializeSubagents`

This keeps feature gating out of route handlers and UI inference code where possible. Runner-side Pi skill and subagent helpers are also instantiated lazily so shell and SSH harnesses do not fail startup just because those unsupported helper constructors exist in the same image.

For Pi, startup also restores the current session's `piScopedModels` into `$PI_CODING_AGENT_DIR/settings.json` after the workspace home archive is available and before the harness starts. Periodic and shutdown sync copy a saved `enabledModels` list back to that session field. Sessions without that canonical field, including sessions created before this behavior existed, clear any model scope inherited through the shared home archive and initialize an empty scope. This keeps `/scoped-models` restart-durable without hiding authenticated providers because another session saved a different filter. The authenticated `/models-file` runner route reads and validates writes to `$PI_CODING_AGENT_DIR/models.json` for the Authentication Center editor. Deploy all curated Pi image tags after changing this route; existing sessions need a new Cloud Run revision before the endpoint is available.

Chrome images seed the harness-neutral `mapache-chrome` skill at the active Pi or Codex workspace skill path when it is missing. The skill tells the agent to run `mapache-chrome-status`, attach to the existing loopback CDP endpoint through the pinned `chrome-devtools-mcp@1.6.0` server, and never launch a second browser or read the profile directory. The reserved `chrome-devtools` MCP entry deterministically replaces a workspace entry with the same name so the image-owned server always attaches to the user-visible browser.

## Frontend

The right drawer now resolves the selected session harness through `src/utils/sessionHarnesses.js` instead of inferring behavior from `imageKey` prefixes or `terminalKind` alone. Auth, Skills, Extensions, and Subagents panels all use the same harness metadata for capability gating, labels, storage paths, and restart hints.

## Verification

- `npm --prefix functions test`
- `npm --prefix session-runner run lint`
- `npm --prefix session-runner test`
- `npm run test:frontend`
- `npm run build`
- `npm run docs:check`

## Related Docs

- [Frontend architecture](./frontend-architecture.md)
- [Backend API architecture](./backend-api-architecture.md)
- [Runtime containers](./runtime-containers.md)
- [Session runner architecture](./session-runner-architecture.md)
- [Pi skills manager](./pi-skills-manager.md)

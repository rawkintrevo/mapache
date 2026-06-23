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

The shared catalog in `functions/runnerCatalog.json` is the source of truth for frontend session pickers and Functions-side image resolution. Each image entry names a `harnessId`, stable `imageKey`, image URI, and preview/function/N64 capability flags. Each harness entry declares whether it supports:

- auth materialization
- workspace-local skills
- MCP materialization
- workspace subagents
- workspace-local packages

The runner cannot import `functions/runnerCatalog.json` directly because the Docker build context is only `session-runner/`. Runner-local harness metadata therefore lives in `session-runner/lib/harnesses/metadata.js` and must stay behaviorally aligned with the shared catalog.

## Auth

Saved user credentials now live in `users/{uid}/private/agentAuth`. During rollout, Functions and runners also read the legacy `users/{uid}/private/piAuth` document and mirror writes there so existing saved Pi credentials remain available until the compatibility path is intentionally removed.

Session-specific selection now lives on the session document as:

```text
authSelection
authSelectionUpdatedAt
```

`authSelection` stores both the target harness and the chosen entry ids per provider. During rollout, backend writes also mirror the provider map into legacy `piAuthSelection`, and runners still read that legacy field for older Pi sessions that have not been resaved yet. The web app and Functions expose neutral auth routes:

```text
GET  /api/auth
PUT  /api/auth/providers/{provider}
DELETE /api/auth/providers/{provider}
DELETE /api/auth/entries/{entryId}
POST /api/workspaces/{workspaceId}/sessions/{sessionId}/auth-selection
```

Legacy `/api/pi-auth/*` aliases still exist for rollout compatibility.

Pi sessions materialize the selected providers into `$HOME/.pi/agent/auth.json`. Codex sessions materialize the selected providers into `$CODEX_HOME/auth.json`. Codex auth supports the OpenAI API key provider plus the OpenAI Codex OAuth token shape used by the local CLI. The runner now writes current Codex auth-mode values (`chatgpt` and `apikey`) and skips materializing saved Codex OAuth credentials that do not include a valid JWT-shaped `id_token`, so a stale or partial saved credential cannot prevent the Codex CLI from starting.

## Skills, MCP, and Subagents

Harness metadata also drives workspace-local file locations:

- Pi skills: `.pi/skills/{name}/SKILL.md`
- Codex skills: `.agents/skills/{name}/SKILL.md`
- Pi subagents: `.pi/agents/{name}.md`
- Codex subagents: `.codex/agents/{name}.toml`

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

Runner startup now resolves the active harness once, then executes harness hooks in order:

1. `materializeConfig`
2. `materializeAuth`
3. `materializeMcp`
4. `materializeSkills`
5. `materializeSubagents`

This keeps feature gating out of route handlers and UI inference code where possible. Runner-side Pi skill and subagent helpers are also instantiated lazily so shell and SSH harnesses do not fail startup just because those unsupported helper constructors exist in the same image.

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

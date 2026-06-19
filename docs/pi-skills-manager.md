# Workspace Skills Manager

## Purpose

This page owns the web surface for workspace-local skills across supported agent harnesses.

## Read When

Read this before changing the Skills drawer, runner skill endpoints, Cloud Functions skill proxy routes, seeded runner skills, or workspace skill sync behavior.

Mapache exposes a web surface for workspace-local skills.

The web manager writes skills into the active harness's native workspace directory:

```text
/workspace/.pi/skills/{skill-name}/SKILL.md
/workspace/.agents/skills/{skill-name}/SKILL.md
```

Pi uses `.pi/skills/{skill-name}/SKILL.md`. Codex uses `.agents/skills/{skill-name}/SKILL.md`. Both stay as normal workspace files instead of a separate registry or database.

## Behavior

- The right drawer `Skills` panel lists workspace-local skills from the active runner.
- Creating or editing a skill writes Markdown with required frontmatter:
  - `name`
  - `description`
- Deleting a skill removes the active harness's `{skills-root}/{skill-name}/SKILL.md` file and its containing skill directory.
- Skill names follow Pi's documented rules: lowercase letters, numbers, and single hyphens.
- Skill descriptions are required and capped at 1024 characters.
- The drawer is available for Pi and Codex sessions. Shell-only sessions do not expose skill management.

Pi scans skills at agent startup. Codex reads workspace skills from `.agents/skills`. If either harness is already running, users may need to restart that agent in the terminal before newly saved skills appear in its skill list.

## Runtime API

The runner exposes protected skill endpoints with the same shutdown-token gate used by Git and package endpoints:

```text
GET  /skills
POST /skills
POST /skills/delete
```

The neutral routes pick the correct native workspace directory from `terminalKind`. Compatibility aliases remain available at `/pi/skills*` so older clients and mixed deploys keep working during rollout.

The endpoints operate inside `/workspace`, then run normal workspace sync so skill files are persisted to Cloud Storage as ordinary workspace files.

Skills do not use archive-backed sync. Unlike Pi packages, skills are small Markdown files and should remain visible in normal workspace file state.

## Runner-Seeded Skills

Mapache-owned seeded skills have one harness-neutral source catalog under `session-runner/seeded-skills/`. The runner selects named profiles from workspace context and capabilities:

- `github` for connected GitHub workspaces.
- `web` for preview-capable non-N64 runners.
- `n64` for N64-capable runners.

Pi and Codex use the same selected catalog entries. During startup, Pi materializes them as ordinary workspace-local skill files under:

```text
/workspace/.pi/skills/{skill-name}/SKILL.md
```

Codex materializes the same files under `.agents/skills/{skill-name}/SKILL.md`. Profile resolution is independent of the agent harness, and the skill text must not name Pi- or Codex-specific runner variants.

The `github` profile includes:

- `mapache-github-issue`: explains how to work from or create GitHub issues by reading repository context, applying type and difficulty labels for new issues, confirming the base branch is up to date before editing, asking clarifying questions or decision questions when needed, implementing the scoped change, and ending with a local commit.

The `web` profile includes:

- `mapache-preview-build`: explains how to build static output to `/workspace/build`.
- `mapache-api-hosting`: explains how to run a localhost app/API server and proxy `/preview/*` to it with `/workspace/.mapache/preview.json`.
- `mapache-preview-qa`: explains how to use preview status, browser logs, screenshots, and Playwright QA artifacts under `$MAPACHE_QA_DIR`.

The `n64` profile includes:

- `mapache-n64-build`: explains how to build/package Nintendo 64 homebrew ROM artifacts to `/workspace/build/game.z64`.
- `mapache-n64-preview`: explains the N64 EmulatorJS preview shell, status endpoint, ROM endpoint, and optional emulator core override.

The runner creates native files only when missing. User-edited files with the same names are not overwritten. Codex additionally imports missing user-authored Pi skills for compatibility; bundled Mapache skills no longer have a separate Codex template tree.

## Backend API

Cloud Functions proxies authenticated requests to the active runner:

```text
GET  /api/workspaces/{workspaceId}/sessions/{sessionId}/skills
POST /api/workspaces/{workspaceId}/sessions/{sessionId}/skills
POST /api/workspaces/{workspaceId}/sessions/{sessionId}/skills/delete
```

The backend verifies Firebase Auth, workspace ownership, session ownership, runner availability, supported harness type, and skill payload shape before proxying. Compatibility aliases remain available at `/api/.../pi-skills*`.

## Security

Skills can instruct the agent to perform actions. Treat skill editing as a privileged workspace mutation:

- Require authenticated backend routes.
- Verify workspace/session ownership.
- Validate skill names, descriptions, and content size.
- Do not execute skill content in the browser or backend.
- Keep skill files in workspace state so users can inspect and commit them when desired.

## Related Docs

- [Frontend architecture](./frontend-architecture.md)
- [Backend API architecture](./backend-api-architecture.md)
- [Runtime containers](./runtime-containers.md)
- [Session runner architecture](./session-runner-architecture.md)

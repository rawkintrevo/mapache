# Pi Skills Manager

Mapache exposes a web surface for workspace-local Pi skills.

Pi discovers skills from Markdown files under `.pi/skills/`. The web manager writes each skill as:

```text
/workspace/.pi/skills/{skill-name}/SKILL.md
```

This matches Pi's skill discovery rules for directories containing `SKILL.md`, keeps skills as normal workspace files, and avoids any separate registry or code-level plugin registration.

## Behavior

- The right drawer `Skills` panel lists workspace-local skills from the active runner.
- Creating or editing a skill writes Markdown with required frontmatter:
  - `name`
  - `description`
- Deleting a skill removes `.pi/skills/{skill-name}/SKILL.md` and its containing skill directory.
- Skill names follow Pi's documented rules: lowercase letters, numbers, and single hyphens.
- Skill descriptions are required and capped at 1024 characters.

Pi scans skills at agent startup. If a Pi TUI is already running, users may need to restart Pi inside the terminal for newly saved skills to appear in the available-skills prompt and `/skill:name` command list.

## Runtime API

The runner exposes protected skill endpoints with the same shutdown-token gate used by Git and package endpoints:

```text
GET  /pi/skills
POST /pi/skills
POST /pi/skills/delete
```

The endpoints operate inside `/workspace`, then run normal workspace sync so `.pi/skills/**` is persisted to Cloud Storage as ordinary workspace files.

Skills do not use archive-backed sync. Unlike Pi packages, skills are small Markdown files and should remain visible in normal workspace file state.

## Runner-Seeded Skills

The `pi-web` runner seeds web-workflow skills during startup after workspace restore and before the Pi terminal process starts. Seeded skills are ordinary workspace-local skill files under:

```text
/workspace/.pi/skills/{skill-name}/SKILL.md
```

Current `pi-web` seeded skills are:

- `mapache-preview-build`: explains how to build static output to `/workspace/build`.
- `mapache-api-hosting`: explains how to run a localhost app/API server and proxy `/preview/*` to it with `/workspace/.mapache/preview.json`.
- `mapache-preview-qa`: explains how to use preview status, browser logs, screenshots, and Playwright QA artifacts under `$MAPACHE_QA_DIR`.

The runner creates these files only when missing. User-edited files with the same names are not overwritten.

## Backend API

Cloud Functions proxies authenticated requests to the active runner:

```text
GET  /api/workspaces/{workspaceId}/sessions/{sessionId}/pi-skills
POST /api/workspaces/{workspaceId}/sessions/{sessionId}/pi-skills
POST /api/workspaces/{workspaceId}/sessions/{sessionId}/pi-skills/delete
```

The backend verifies Firebase Auth, workspace ownership, session ownership, runner availability, and skill payload shape before proxying.

## Security

Skills can instruct the agent to perform actions. Treat skill editing as a privileged workspace mutation:

- Require authenticated backend routes.
- Verify workspace/session ownership.
- Validate skill names, descriptions, and content size.
- Do not execute skill content in the browser or backend.
- Keep skill files in workspace state so users can inspect and commit them when desired.

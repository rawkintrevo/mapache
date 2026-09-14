# Runner Harnesses

Runner image identity and harness metadata are shared between Functions and
the runner. The catalog is generated into the runner image so the container
does not import the Functions package directly.

## Canonical owners

- Shared catalog: `functions/runnerCatalog.json`
- Functions resolution: `functions/runnerCatalog.helpers.js` and
  `functions/runnerImages.helpers.js`
- Frontend identity/auth lookup: `src/utils/sessionHarnesses.js`
- Runner metadata/bootstrap: `session-runner/lib/harnesses/metadata.js` and
  `session-runner/lib/harnesses/index.js`
- Generated runner copy: `session-runner/lib/harnesses/generatedCatalog.json`

## Current behavior

Each session records a stable `harnessId`; `imageKey` selects the only supported
curated image, `pi-chrome`, and `terminalKind` remains a compatibility runtime
hint for restored records. Historical session documents can still be displayed
and cleaned up, but they are not launchable. New session creation is
server-owned and resolves the marked `pi-chrome`/Pi combination.

Image capabilities describe terminal, Preview, Preview QA, Functions, and
Chrome access. Legacy Chat, Goals, SSH, and N64 capability flags are not part of
the supported catalog. The frontend uses the catalog for access-surface
decisions and credential-harness selection; it does not use it to render
Mapache managers for upstream files, Git, models, skills, extensions,
subagents, or Goals.

## Auth and connections

Mapache remains the credential owner. Saved entries are private user data,
session documents store only selected entry IDs, and runner startup materializes
the selected provider credentials into the appropriate native auth target. The
managed Pi runtime uses its fixed internal auth path after restore and before
the upstream child starts. Generic environment values, Google tokens, MCP
OAuth, and GitHub CLI credentials are likewise resolved/materialized server-side
and excluded from agent snapshots.

The frontend exposes top-navigation dialogs for saved authentication, generic environment keys, and MCP, plus
Google Workspace and GitHub connector workflows. Upstream owns model metadata,
model selection, skills, extensions, subagents, files, Git, and native Goals.

## Startup hooks

Runner harness resolution provides a small ordered set of startup hooks:

1. `materializeConfig`
2. `materializeAuth`
3. GitHub source preparation
4. `materializeMcp`
5. image-owned runtime skill seeding
6. managed upstream agent launch when `agentRuntimeEnabled` is true

Pi skill seeding is limited to missing Mapache-owned runtime skill files needed
to explain retained Chrome/MCP integration. These hooks do not expose a CRUD API
or replace upstream's settings and discovery behavior.

The runner has no harness hook or route for Mapache Goals, Chat, package CRUD,
model editing, file editing, Git controls, skills CRUD, or subagent CRUD. The
minimal `agentRoutes.js` file retains only auth materialization endpoints for
the server-owned credential boundary.

## Invariants and verification

- Browser payloads cannot choose a runner image or harness.
- `pi-chrome` is the only catalog image and the only image accepted by
  provisioning and release automation.
- Catalog changes regenerate `session-runner/lib/harnesses/generatedCatalog.json`.
- Existing Cloud Run services keep their old image until a revision/recreation;
  rebuilding a tag alone does not change a running service.
- Run `npm run generate:runner-catalog -- --check`, runner tests, frontend tests,
  and `npm run docs:check` after catalog/harness changes.

## Related docs

- [Backend API architecture](./backend-api-architecture.md)
- [Frontend architecture](./frontend-architecture.md)
- [Runtime containers](./runtime-containers.md)
- [Session runner architecture](./session-runner-architecture.md)

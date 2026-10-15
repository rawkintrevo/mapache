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

When a GitHub CLI token is saved, Functions verifies it through GitHub's
authenticated-user endpoint and stores the resolved login with the private
credential. Selecting an older GitHub CLI entry that lacks a login performs the
same verification and backfills the entry before asking the live runner to
materialize `$HOME/.config/gh/hosts.yml`. This keeps existing runner revisions
compatible while ensuring `gh` receives both the token and active username.

The frontend exposes top-navigation dialogs for saved authentication, generic environment keys, and MCP, plus
Google Workspace and GitHub connector workflows. Upstream owns model metadata,
interactive model selection, skills, extensions, subagents, files, Git, and native Goals.
The [automation editor](./automations.md) separately selects the provider/model
pair stored on an automation definition, using a generated export of the pinned
runner catalog. It does not change the interactive Agent's model or require an
active runtime.

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

## Named OpenAI-compatible connections

Mapache Authentication accepts provider IDs in the reserved `custom-` namespace
(lowercase letters, digits, and hyphens; up to 70 characters including the prefix).
`functions/customPiProviders.helpers.js` owns API validation; the existing
owner-private auth entries and session selection retain separate credentials for
multiple custom providers alongside built-ins. IDs are immutable on edit; labels
and keys can change. The base URL is stored with each credential as
`mapacheBaseUrl`, normalized without a trailing slash, and must be HTTP(S) without
URL credentials, query parameters, or fragments. Supply a placeholder key for an
endpoint without authentication. Custom headers and custom OAuth are not supported
by this connection type.

The UI collects the ID, endpoint, label, and key, but models remain upstream-owned.
Select the connection in Manage Pi Auth and restart the workspace. In Agent
Settings → Models, edit the matching provider to fetch or enter served model IDs,
context/output limits, reasoning, and input capabilities. The initial API is
`openai-completions` (Chat Completions). Endpoints must be reachable from the runner;
localhost refers to the cloud container, not the user's computer.

`session-runner/lib/customPiModels.js` seeds matching provider metadata after
checkpoint restore and canonical auth materialization. A changed endpoint clears
its old model list so the user discovers/configures models for the new server.
Deselection retains non-secret metadata but removes the provider's canonical
credential. Credential edits/deletion/selection require a workspace restart to
invalidate any upstream in-memory auth overrides.

Patch `0017-custom-provider-connections.patch` makes both edit-form discovery and
saved-provider refresh resolve the custom key from server-side `auth.json` using
the provider ID and the bound endpoint. Metadata saves cannot redirect that
credential to another endpoint or model-specific endpoint. Discovery does not
follow redirects or expose upstream error response bodies. Existing built-in
provider behavior and managed credential-entry restrictions remain in place.

Raw `models.json` remains excluded from checkpoints. Snapshot capture writes a
validated projection to `pi/mapache-models.json`; startup revalidates it and
reconstructs the custom entries. The projection includes only custom provider
IDs, base URLs, Chat Completions API, names, model IDs, capabilities, limits,
cost metadata, and explicitly supported compatibility flags/enums. It drops
inline keys, headers, commands, model-specific endpoints, and unknown fields.
Advanced sampling/templates and arbitrary provider extensions are not part of
this persistence contract. Built-in provider overrides retain the existing
snapshot behavior. Metadata is workspace-scoped; connection credentials are
user-scoped. An automation must receive the appropriate workspace agent
checkpoint and current credential selection; this change does not add custom
models to the generated automation catalog or a separate automation setup UI.

Verify with the custom-provider Functions tests, runner `customPiModels.test.js`,
upstream `mapache-custom-provider.test.ts` (authenticated discovery and streamed
tool call through the pinned SDK), and `e2e/qa/cases/auth-custom-provider.json`.
Deploy the API and rebuild `pi-chrome`; existing sessions need a new revision
before the custom connection runtime behavior is available.

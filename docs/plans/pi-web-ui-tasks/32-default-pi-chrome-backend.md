# Task 32: Make pi-chrome the sole backend creation path

Difficulty: medium. Depends on Tasks 1–31. Status lives in [the root checklist](../../../task_list.md).

## Starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then these repository-relative paths:

- `functions/runnerCatalog.json`
- `functions/sessionCreation.service.js`
- `functions/sessionLifecycle.service.js`
- `src/config/sessionImages.js`

Use actual paths/IDs from prior task evidence, not guessed names. Read focused wiki pages before editing code.

## Ownership

Catalog/generation scripts and backend workspace/session creation defaults.

## Steps

1. Make new blank/GitHub workspaces use pi-web-ui-v1 and pi-chrome automatically; keep no client-selectable alternate runtime.
2. Reject unsupported image keys, SSH creation, and arbitrary image URIs server-side. Permit inactive historical records to remain readable without launching them.
3. Apply one-runner transaction/generation rules to all new starts, retaining resource presets and idempotent retries.
4. Remove rollout administration from ordinary product flows while retaining a controlled rollback procedure for the single migration.
5. Regenerate catalog artifacts, deploy Functions, and validate the migrated HubSpot access/lifecycle plus fresh workspace creation.

## Acceptance criteria

- Only pi-chrome can be provisioned, including forged API requests.
- One-runner invariant applies to default creation, not only a QA marker.
- Generated catalogs match; Functions deployment and fresh/migrated workspace smoke pass.

## Validation

Catalog check, Functions validation/race tests and lint, required Functions deploy, frontend build if generated files change.

Update affected canonical docs for behavior changes and run `npm run docs:check`. Follow the execution guide's deployment and commit rules.

## Boundary and stop conditions

Do not silently delete/convert other users' historical workspaces or stop unowned services. All shared stop conditions apply. Leave this task unchecked if any required check fails or access is missing.

## Handoff

Record actual commands/results, safe evidence references, and any recovery actions under Task 32 in the root checklist. Commit before continuing to Task 33.


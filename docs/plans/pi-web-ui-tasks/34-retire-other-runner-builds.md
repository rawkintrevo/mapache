# Task 34: Remove unsupported runner families and build paths

Difficulty: medium. Depends on Tasks 1–33. Status lives in [the root checklist](../../../task_list.md).

## Starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then these repository-relative paths:

- `.github/workflows/runner-images.yml`
- `scripts/runner-image-release.mjs`
- `docs/runner-harnesses.md`

Use actual paths/IDs from prior task evidence, not guessed names. Read focused wiki pages before editing code.

## Ownership

Obsolete Dockerfiles/cloudbuild files, catalog support, CI matrices, and harness-specific runtime code.

## Steps

1. Trace pi-chrome's build dependency graph before removing unsupported Dockerfiles. Extract any genuinely shared retained helper rather than breaking inheritance.
2. Reduce supported image release/build logic to pi-chrome, including CI detection, immutable tags, catalog tests, and generated artifacts.
3. Remove dead Codex/SSH/N64/default runner product/bootstrap/auth paths while preserving Mapache-managed Pi credentials, GitHub and Google connection services.
4. Keep historical documentation/data clearly historical; do not mass-delete remote images, services or workspace records.
5. Update runtime/harness/deployment docs to one supported runner.

## Acceptance criteria

- A clean pi-chrome image build does not depend on a removed file/image.
- Supported workflows/catalog expose only pi-chrome and CI no longer tries other runners.
- Retained credential/connector/Chrome/preview functions pass focused regression checks.

## Validation

Catalog generator --check, affected release-script tests, clean pi-chrome build, runner/Functions lint/tests as touched, npm run build; deploy Functions if changed.

Update affected canonical docs for behavior changes and run `npm run docs:check`. Follow the execution guide's deployment and commit rules.

## Boundary and stop conditions

No remote Artifact Registry purge or removal of recoverable migration data. All shared stop conditions apply. Leave this task unchecked if any required check fails or access is missing.

## Handoff

Record actual commands/results, safe evidence references, and any recovery actions under Task 34 in the root checklist. Commit before continuing to Task 35.


# Task 25: Write bounded hosted QA cases and migration checks

Difficulty: medium. Depends on Tasks 1–24. Status lives in [the root checklist](../../../task_list.md).

## Starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then these repository-relative paths:

- `.agents/skills/qa-test/SKILL.md`
- `e2e/qa/README.md`
- `docs/testing.md`

Inspect actual owner code and predecessor handoffs before editing. Upstream paths refer to the pinned source from Task 2.

## Ownership

Checked-in cases/scripts under e2e/qa and a release evidence template.

## Steps

1. Compose reusable login and workspace setup manifests for an explicitly marked disposable pi-chrome workspace.
2. Define functional assertions for chat/tools, multiple histories, terminal/files/Git, native Goals, credentials/MCP, Chrome/Preview, renewal, stop/restart, and session resource changes.
3. Define deterministic fault cases for disconnect, duplicate start, revoked writer, storage failure, replacement and no automatic resume.
4. Specify safe provider selection from existing configured credentials, test-turn/time bounds from contracts, read-only connector checks, cleanup IDs, screenshots/network evidence, and exact pass/fail expectations.
5. Add migration verification instructions based on Tasks 23–24 with no transcript/secret content in public evidence.

## Acceptance criteria

- Each case has explicit setup, assertions, evidence, and bounded cleanup using recorded IDs.
- No unsupported manifest step or invented credential source is required.
- Missing model/browser/cloud access produces blocked, not a mock pass.

## Validation

Validate manifest JSON and composition references; run npm run docs:check. Executing hosted cases is reserved for Tasks 27–28.

Update the affected canonical wiki page for behavior changes and run `npm run docs:check`. Follow the execution guide's deployment and commit rules.

## Boundary and stop conditions

Do not use real HubSpot CRM writes, unbounded Goal loops, or a new QA framework. Shared stop conditions apply; leave the root checkbox unchecked on any blocked acceptance criterion.

## Handoff

Record actual paths, commands/results, safe evidence references, and contract changes under Task 25 in the root checklist. Commit the completed task before continuing to Task 26.


# Task 27: Run hosted functional browser QA

Difficulty: medium. Depends on Tasks 1–26. Status lives in [the root checklist](../../../task_list.md).

## Starting context

Read [execution rules](./README.md), [fixed decisions](./decisions.md), and [contracts](./contracts.md), then these repository-relative paths:

- `.agents/skills/qa-test/SKILL.md`
- `e2e/qa/README.md`

Use actual paths/IDs from prior task evidence, not guessed names. Read focused wiki pages before editing code.

## Ownership

Task 25 manifests and Task 27 QA evidence.

## Steps

1. Use Chrome DevTools and the checked-in manifests against the Task 26 preview/canary.
2. Verify streamed chat/tools, two conversations, history across a fresh client, terminal, file editing/download/upload, Git in a disposable repository, native Goal, and model selection.
3. Verify Mapache credential/connection controls, safe MCP tool discovery/read, Persistent Chrome, Preview, and metrics.
4. Exercise access renewal and tab switching during a turn, checking no duplicate prompt/model turn and no iframe reload.
5. Observe bounded model-turn/time limits; stop the test on relevant console/network/assertion failure and fix the responsible task's implementation before rerunning.

## Acceptance criteria

- Every functional case passes with real browser evidence and no unexpected console/network errors.
- Read-only connector checks work without exposing credentials or mutating HubSpot.
- The same source commit/image digest is recorded throughout the passing run.

## Validation

All functional manifests with structured results, screenshots and safe network summaries; missing browser/model access is blocked.

Update affected canonical docs for behavior changes and run `npm run docs:check`. Follow the execution guide's deployment and commit rules.

## Boundary and stop conditions

No real HubSpot data mutations or claims that deterministic fixture-only tests are live QA. All shared stop conditions apply. Leave this task unchecked if any required check fails or access is missing.

## Handoff

Record actual commands/results, safe evidence references, and any recovery actions under Task 27 in the root checklist. Commit before continuing to Task 28.


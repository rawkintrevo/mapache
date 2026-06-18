---
name: qa-test
description: Run or compose Mapache browser QA tests from checked-in e2e/qa case manifests using Chrome DevTools. Use when the user explicitly asks for QA testing, smoke testing, browser testing, end-to-end testing, or a named QA case, and when issue-workflow changes frontend behavior and requires QA before PR completion.
---

# QA Test

## Workflow

1. Read `docs/testing.md` and `e2e/qa/README.md`.
2. Select the requested case from `e2e/qa/cases/`. If no case is named, start with `e2e/qa/cases/login.json`.
3. When invoked by `issue-workflow` for frontend changes, choose an existing case that covers the changed user path, or add/update a checked-in case manifest under `e2e/qa/cases/`.
4. Resolve each `useCase` and `useScript` step relative to `e2e/qa/`.
5. Start or reuse the local dev server. Prefer `npm run dev`; the default URL is `http://127.0.0.1:5173`.
6. Use Chrome DevTools to execute browser steps. Do not invent credentials, target URLs, cleanup actions, or pass/fail criteria beyond the manifest.
7. Store generated screenshots, console logs, network summaries, traces, and result JSON under `artifacts/qa/<case-id>/`. `artifacts/` is ignored.
8. Treat the case as failed if assertions fail, expected UI is missing, screenshots are broken, relevant network calls fail, or the browser console contains unexpected errors.
9. Report structured results with `scenarioId`, `status`, `observations`, `evidence`, and `failureReason`.

## Issue Workflow Use

When this skill is invoked from `issue-workflow` because frontend behavior changed:

1. Compose cases by reusing existing `useCase` and `useScript` steps, especially the login case, before adding bespoke steps.
2. Add or update a checked-in QA case when no existing manifest covers the changed behavior.
3. Run the relevant QA case before the issue workflow opens the PR.
4. If QA finds issues, fix the implementation or manifest and rerun until the case passes with no unexpected console or network errors.
5. Provide screenshot artifact paths and any result JSON path back to `issue-workflow` so the PR can include the screenshots.
6. If Chrome DevTools, QA credentials, or another required dependency is unavailable, return `blocked` and name the missing setup instead of marking QA as passed.

## Secrets

Use the QA login secret only from an existing local ignored source or an explicit user-provided value. Acceptable local sources:

- `functions/.env.local`
- process environment `QA_LOGIN_SECRET`
- a GitHub Actions secret when a workflow explicitly runs QA

Never write QA secrets to tracked files, screenshots, console output, result JSON, or final answers.

## Manifest Semantics

Scripts are single reusable actions, such as `scripts/login-qa.json`. Cases are ordered sequences under `cases/` and may compose scripts or other cases.

Supported step keys:

- `useScript`: Load and execute a reusable script manifest.
- `useCase`: Load and execute another case manifest before continuing.
- `assert`: Verify the named expectation using page snapshot, console, network, or deterministic script output.
- `capture`: Save the requested artifact.

When a manifest contains an unsupported step, stop and report the unsupported key instead of guessing.

## Login Case

The baseline login case is `e2e/qa/cases/login.json`. It composes `e2e/qa/scripts/login-qa.json` and validates:

- QA custom-token endpoint returns `200`.
- Firebase custom-token sign-in returns `200`.
- `/api/me` returns `200`.
- The signed-in shell reaches the `Create a workspace` state.

If it fails with `qa_login_user_update_failed`, check that the Cloud Functions API service account has `roles/firebaseauth.admin`. If it fails with `app_access_not_allowed`, add the QA UID or email to `appConfig/access`.

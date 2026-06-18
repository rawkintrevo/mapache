---
name: qa-test
description: Run Mapache browser QA tests from checked-in e2e/qa case manifests using Chrome DevTools. Use only when the user explicitly asks for QA testing, smoke testing, browser testing, end-to-end testing, or to run a named QA case; do not run these tests as part of normal implementation, build, or PR checks unless requested.
---

# QA Test

## Workflow

1. Read `docs/testing.md` and `e2e/qa/README.md`.
2. Select the requested case from `e2e/qa/cases/`. If no case is named, start with `e2e/qa/cases/login.json`.
3. Resolve each `useCase` and `useScript` step relative to `e2e/qa/`.
4. Start or reuse the local dev server. Prefer `npm run dev`; the default URL is `http://127.0.0.1:5173`.
5. Use Chrome DevTools to execute browser steps. Do not invent credentials, target URLs, cleanup actions, or pass/fail criteria beyond the manifest.
6. Store generated screenshots, console logs, network summaries, traces, and result JSON under `artifacts/qa/<case-id>/`. `artifacts/` is ignored.
7. Report structured results with `scenarioId`, `status`, `observations`, `evidence`, and `failureReason`.

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

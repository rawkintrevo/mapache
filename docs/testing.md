# Testing Strategy

This repo uses a small test pyramid that keeps pull-request checks fast while leaving browser, Cloud Run, and LLM-assisted regressions for explicit or scheduled runs.

## Test Layers

### Unit tests

Unit tests cover pure helpers and validation logic that can run without Firebase emulators, live Google Cloud APIs, browsers, or runner containers.

Locations:

- `functions/*.helpers.test.js` for backend helper modules.
- Frontend helper tests should live next to the tested helper under `src/` using `*.test.js` or in `src/__tests__/` when a shared fixture is needed.
- Future runner helper tests should live under `session-runner/lib/` as `*.test.js` when the helper can be isolated from Express, PTY, Cloud Storage, and GitHub.

Default commands:

```bash
npm --prefix functions test
npm run test:frontend
npm --prefix session-runner run lint
```

### Integration and contract tests

Integration tests cover boundary behavior between modules without deploying live infrastructure. They should prefer in-process route handlers, mocked Firebase Admin clients, mocked Cloud Run clients, and temporary local workspaces over live GCP calls.

Locations:

- `functions/__tests__/` for route parsing, API contract, ownership, validation, and error-response tests around `functions/index.js` and extracted backend modules.
- `session-runner/__tests__/` for Express route contracts, token gates, preview path validation, Git command orchestration, and workspace sync behavior that can run with temporary directories and mocked services.
- `src/__tests__/` for React workflow/component smoke tests. These run with Vitest, jsdom, and React Testing Library, and should mock Firebase, runner, and API boundaries so they stay local-only.

These tests should become part of `npm run check` only when they are deterministic, local-only, and fast enough for PR feedback.

### End-to-end tests

End-to-end tests exercise the hosted app or local Firebase emulator plus browser behavior. They validate user-visible workflows rather than implementation details.

Locations:

- `e2e/` for Playwright or equivalent browser flows.
- `e2e/qa/` for explicit Chrome DevTools-assisted QA manifests. These tests are opt-in only and should be run only when the user directly asks for QA, smoke, browser, or end-to-end testing.
- `docs/guides/*-regression-checklist.md` for human-readable scenario checklists that are not automated yet.

Candidate flows:

- Authentication and app shell load.
- Blank workspace create/open/delete.
- Session create/open/stop/delete with terminal access-token validation.
- GitHub workspace clone/resume/status/push behavior.
- `pi-web` preview status, static preview, proxy preview, and browser log capture.
- Skills and Extensions drawer smoke paths against a controlled runner fixture.

E2E tests should not run in normal PR workflows until they are reliable, bounded, and credential-light. Run them manually before risky deploys and in scheduled workflows once automation exists.

### Nightly and release regression tests

Nightly tests are allowed to be slower and may use deployed preview environments, real Firebase services, or short-lived Cloud Run sessions when credentials are available.

Locations:

- `.github/workflows/` for scheduled or manually dispatched workflows.
- `e2e/nightly/` for slower browser, GitHub App, Cloud Run lifecycle, and package-manager regression suites.
- `artifacts/` or workflow-uploaded artifacts for screenshots, traces, request logs, terminal transcripts, runner logs, and generated summaries.

Nightly suites should include cleanup that stops and deletes created Cloud Run services and removes temporary workspaces.

## Fast PR Checks

The default root command is:

```bash
npm run check
```

It runs:

1. Developer docs relative-link validation.
2. Cloud Functions unit tests.
3. Session runner JavaScript syntax checks.
4. Frontend smoke tests.
5. Full Vite app and Docusaurus community build.

Firebase preview and production workflows should keep mirroring this fast set: install root, `community/`, `functions/`, and `session-runner/` dependencies; run Functions tests; run runner syntax checks; run frontend smoke tests; then build. N64 image builds, live Cloud Run provisioning, browser E2E, and LLM-assisted regressions stay out of the default PR path.

## Slower Checks

Run slower checks when a change touches the related subsystem:

- Backend routing or ownership: route/contract tests and Firebase emulator checks when available.
- Runner terminal, preview, PTY, workspace sync, or Git behavior: runner integration tests plus the relevant human checklist until automated E2E exists.
- Frontend workspace/session UI: frontend smoke tests once added, plus Playwright E2E for critical flows.
- Deployment, service accounts, Cloud Run provisioning, or Firebase rules: staging deploy or scheduled workflow with explicit `--project pi-agents-cloud` flags.
- N64 runtime behavior: explicit N64 container build/smoke workflow only, never the default root check.

## LLM-Assisted Regression Suite

LLM-assisted regression checks are useful for broad UI and workflow review, but they must be deterministic enough to produce actionable failures.

Recommended location:

- `e2e/qa/scripts/` for reusable single-action QA scripts.
- `e2e/qa/cases/` for ordered QA cases that compose scripts and other cases.
- `e2e/llm-regression/` for prompts, scenario manifests, fixtures, and result parsers.
- `.github/workflows/` for a `workflow_dispatch` and optional nightly schedule after the suite is stable.

Chrome DevTools browser QA can reach the signed-in shell through the QA custom-token flow. Before opening `/app`, set `mapache.qaLogin=1` and `mapache.qaSecret=<secret>` in browser storage, or use `/app?qaLogin=1&qaSecret=<secret>` for a one-time login trigger. The frontend removes `qaSecret` from the URL after reading it. The backend route is `POST /api/qa/custom-token`, backed by `functions/qaAuth.service.js`, and requires the configured QA account to pass the same app allowlist as normal users.

QA manifests under `e2e/qa/` are executable instructions for agents, not default checks. A script is one reusable browser action, such as QA login. A case is a sequence of actions and assertions, and may reference scripts with `useScript` or other cases with `useCase`. The baseline case is `e2e/qa/cases/login.json`; follow-on cases should compose it instead of duplicating login steps.

The initial QA catalog covers signed-in shell and empty states, navigation drawers, profile usage, blank and GitHub workspace creation, workspace files and editor behavior, session creation/lifecycle, Authentication Center, Pi auth selection, Skills, Extensions, Git status, Git commit/push/PR flows, and a broad blank-workspace smoke case. High-cost or externally mutating cases declare `requires` blocks and should be curated before running.

Guardrails:

- Use fixed scenario manifests checked into the repo. Do not let the model invent target URLs, credentials, cleanup actions, or pass/fail criteria.
- Run against a known base URL, seeded test accounts, seeded workspaces, and isolated temporary session names.
- Give the model read-only observation tasks by default. Require explicit tool allow-lists for browser clicks, form fills, terminal input, or API calls.
- Set timeouts, step limits, and token budgets per scenario.
- Prefer structured JSON results with `scenarioId`, `status`, `observations`, `evidence`, and `failureReason` over free-form prose.
- Treat model output as a triage signal, not as the only assertion. Pair it with deterministic checks such as HTTP status, DOM selectors, screenshot existence, console error counts, and API response shapes.
- Always upload artifacts: prompt, model version, scenario manifest, browser trace, screenshots, console logs, network errors, terminal transcript, and structured result JSON.
- Include cleanup scenarios or deterministic post-run cleanup scripts for all created workspaces, sessions, branches, and pull requests.

Commit-time LLM checks should be opt-in and local. Chrome DevTools-assisted QA cases should not run during ordinary implementation or handoff unless the user asks for them. Nightly LLM checks may run automatically only after artifacts, credentials, and cleanup are proven reliable and a workflow has been explicitly added for that purpose.

## Related Docs

- [Wiki update protocol](./wiki-update-protocol.md)
- [Deployment](./deployment.md)
- [Subsystem map](./subsystem-map.md)

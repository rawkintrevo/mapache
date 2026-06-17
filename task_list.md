# Mapache Maintenance Task List

## Goal

Make the repository easier to change safely after rapid feature growth. This phase focuses on cleanup, test coverage, and maintainability boundaries. `community/` remains the user-facing docs/blog surface and is intentionally out of scope for this maintenance pass unless a task explicitly says otherwise.

## Task Sizing

- `easy`: narrow file movement, metadata, docs, small script changes, or focused helper extraction.
- `medium`: scoped refactors with tests around one subsystem.
- `large`: broad subsystem split, multiple call sites, or new integration/e2e infrastructure.
- `human`: product decision, issue triage, live production verification, or external service setup.

## Source Documents

Before implementation tasks, read:

- `AGENTS.md`
- `docs/app-overview.md`
- `docs/runtime-containers.md`
- `docs/ui-components.md`
- Any focused doc for the subsystem being changed.

## Scope Notes

- `docs/` is developer/LLM implementation knowledge.
- `community/` is user-facing docs and blog content; leave it alone in this phase.
- Keep the landing page and current jumbotron asset in place for now.
- Treat the N64 runner as a fun side project, not part of the main maintenance path. Avoid adding it to routine heavy builds unless a task is explicitly about N64.
- The large `functions/index.js` decomposition has already been mapped into repo issues; use those issues for detailed sequencing instead of duplicating that plan here.

## Tasks

- [x] 1. **Archive old task artifacts** - easy
  - Move the completed extension-manager task list to `docs/prior_task_lists/workspace-local-pi-extension-manager.md`.
  - Move the old landing-page brief to `docs/prior_task_lists/mapache-tools-landing-page-brief.md`.
  - Move the prior GitHub connectivity task list to `docs/prior_task_lists/github-connectivity.md`.
  - Normalize the archive folder name to `docs/prior_task_lists/`.

- [x] 2. **Document docs/community ownership boundary** - easy
  - Update `AGENTS.md` to state that `docs/` is developer/LLM implementation knowledge.
  - Update `AGENTS.md` to state that `community/` is user-facing docs/blog content and should be left out of developer-doc maintenance unless explicitly requested.

- [x] 3. **Add a root verification script** - easy
  - Add a root `check` script that runs Functions tests, runner syntax checks, and the full app/community build.
  - Keep N64 image builds out of this default check.
  - Document the command in `README.md` or the relevant developer doc.
  - Completed: 2026-06-17 - Added root `npm run check`, session-runner syntax linting, and README usage notes.

- [x] 4. **Update CI to validate the session runner** - medium
  - Install `session-runner/` dependencies in preview and production workflows.
  - Run runner syntax checks in CI.
  - Do not add heavy N64 container builds to normal PR checks.
  - Completed: 2026-06-17 - Added session-runner dependency install and syntax lint steps to preview and production workflows.

- [x] 5. **Design the test pyramid for this repo** - medium
  - Define where unit, integration, e2e, and nightly tests live.
  - Identify fast PR checks versus slower nightly checks.
  - Include an LLM-assisted regression suite design for commit or nightly runs, with deterministic guardrails and clear failure artifacts.
  - Completed: 2026-06-17 - Added `docs/testing.md` with the repo test pyramid, PR/nightly split, and LLM regression guardrails.

- [x] 6. **Add route/contract tests before backend decomposition** - medium
  - Cover `functions/index.js` route parsing and representative API contracts.
  - Include ownership/error behavior where practical without hitting live GCP.
  - Use these tests as the safety net for following the existing repo-issue decomposition plan.
  - Completed: 2026-06-17 - Added API route helper coverage for route parsing, method contracts, and auth/public route expectations.

- [x] 7. **Follow repo issues for `functions/index.js` decomposition** - large
  - Use existing GitHub issues as the detailed plan.
  - Keep this task as the maintenance-list pointer rather than duplicating the issue breakdown.
  - Preserve behavior with tests before moving code.
  - [x] Issue #42: 2026-06-17 - Extracted route parsing and grouped dispatch helpers with contract coverage.
  - [x] Issue #43: 2026-06-17 - Extracted backend context, config, and shared utility helpers with focused tests.
  - [x] Issue #44: 2026-06-17 - Extracted auth/access/profile and usage accounting services with focused tests.
  - [x] Issue #45: 2026-06-17 - Extracted workspace CRUD and Cloud Storage file services with focused tests.
  - Completed: 2026-06-17 - Followed the non-overlapping issue #42-#45 backend decomposition slices; Cloud Run, GitHub, and Pi-specific extractions continue in tasks 8-10.

- [x] 8. **Extract Cloud Run provisioning helpers** - medium
  - Move Cloud Run service build/patch/delete/service-account logic out of `functions/index.js`.
  - Add direct tests for service account selection, image capability metadata, env construction, and failure messages.
  - Completed: 2026-06-17 - Extracted `functions/cloudRun.service.js` for Cloud Run create/patch/delete, service-account resolution, resource limits, shutdown/delete behavior, and runner env construction with direct helper tests.

- [ ] 9. **Extract GitHub backend helpers** - medium
  - Move GitHub OAuth/App token/repository/PR helpers out of `functions/index.js`.
  - Add tests for normalization, token permission parsing, branch naming, and API error mapping.

- [ ] 10. **Extract Pi backend proxy helpers** - medium
  - Move Pi auth, package, and skill proxy behavior out of `functions/index.js`.
  - Add tests for payload validation and stable user-facing errors.

- [ ] 11. **Split runner Pi service** - medium
  - Split `session-runner/lib/pi.js` into package service, skill service, seeded skill loading, and validation helpers.
  - Keep runner endpoint behavior unchanged.
  - Add focused tests for package source and skill validation if practical.

- [ ] 12. **Move seeded skill Markdown out of JS strings** - medium
  - Store default seeded skill content as Markdown files under `session-runner/`.
  - Load those files from runner code.
  - Keep the "create only when missing" behavior.

- [ ] 13. **Split runner Git service** - medium
  - Separate command execution, status parsing, branch/commit validation, push auth, and PR helpers.
  - Add tests for porcelain parsing and branch/payload validation.

- [ ] 14. **Split runner workspace service** - medium
  - Separate sync, archive handling, GitHub workspace restore, and Pi home persistence.
  - Add tests around path filtering and archive target selection.

- [ ] 15. **Reduce frontend state fan-out from `src/main.js`** - large
  - Extract cohesive controllers/hooks for selected workspace/session state, modal state, right-drawer panels, and file editor state.
  - Keep React component APIs smaller so simple UI edits do not require touching the main app coordinator.

- [ ] 16. **Plan CSS decomposition** - medium
  - Audit `src/styles.css` and decide whether to use component-local CSS files, CSS modules, or a hybrid.
  - Recommended direction: keep tokens/layout primitives global, move component-specific overrides beside their components, and avoid one-off global selectors where a component boundary exists.
  - Implement incrementally by component area instead of one large rewrite.

- [ ] 17. **Add frontend smoke coverage** - medium
  - Cover route gating, signed-in shell rendering, drawer panels, session selection, and key modal flows.
  - Prefer tests that can run in PR checks without live Cloud Run sessions.

- [ ] 18. **Add nightly e2e coverage plan** - large
  - Define live-environment tests for authenticated session creation, workspace files, GitHub workspaces, Pi packages, Pi skills, and runner preview.
  - Keep these out of every PR unless they become cheap and reliable.
  - Include failure artifacts such as screenshots, logs, and API responses.

- [ ] 19. **Review large tracked assets later** - human
  - Leave the landing page and jumbotron unchanged for now.
  - Revisit image compression/replacement in a separate product-facing pass.

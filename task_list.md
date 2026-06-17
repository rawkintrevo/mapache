# Developer Wiki Refactor Task List

## Goal

Refactor `docs/` into a developer-facing, LLM-friendly knowledge base. The result should make future agents and maintainers quickly answer:

- What is this system?
- Which docs should I read before touching a subsystem?
- What is canonical versus historical?
- How should I update the wiki after changing code?

This is a practical "Karpathy-style if you squint" docs pass: preserve useful raw notes, create concise navigable summaries, add strong reading/update protocols, and avoid a heavy generated-docs framework.

## Scope

- `docs/` is both the raw material and the output wiki.
- `community/` remains user-facing docs/blog content and is out of scope.
- `adrs/` remains the decision-record archive unless a task explicitly links or indexes it from `docs/`.
- `docs/prior_task_lists/` is historical and should stay separate from the active wiki path.
- Code refactors are out of scope unless needed to support docs validation or local agent skills.

## Task Sizing

- `easy`: focused docs edits, index pages, templates, small validation scripts, or skill scaffolding.
- `medium`: reorganizing several docs, creating cross-linked subsystem pages, or adding docs validation.
- `large`: broad rewrite of multiple architecture docs or creating automation that changes docs structure.
- `human`: product/architecture decisions, final information architecture approval, or resolving unclear source-of-truth conflicts.

## Source Documents

Before implementation tasks, read:

- `AGENTS.md`
- `docs/app-overview.md`
- `docs/runtime-containers.md`
- `docs/github-workspaces.md`
- `docs/testing.md`
- `docs/ui-components.md`
- `docs/STYLE_GUIDE.md`
- The focused docs for the subsystem being edited.

## Wiki Principles

- Optimize for agent routing first: every doc should say when to read it and what it owns.
- Keep summaries short and link to deeper raw/source pages.
- Historical task lists belong under `docs/prior_task_lists/`, not in the active navigation path.
- Prefer one canonical page per subsystem, with explicit "related docs" links.
- When docs disagree, create a task or note the uncertainty instead of silently choosing a truth.
- Do not move or rewrite `community/` content in this phase.

## Tasks

- [x] 1. **Inventory and classify current docs** - easy
  - List every file under `docs/` and `adrs/`.
  - Classify each as active wiki, raw source material, historical archive, generated/reference asset, or stale candidate.
  - Flag broken links and missing referenced pages, including the current `docs/css-decomposition.md` reference.

- [x] 2. **Define the target wiki information architecture** - human
  - Decide the top-level wiki sections and naming convention.
  - Keep `docs/prior_task_lists/` as archive-only.
  - Decide whether ADRs stay outside `docs/` with a wiki index or move under a docs decision-log section.

- [x] 3. **Create the wiki entrypoint** - easy
  - Add `docs/README.md` as the first file an agent should read.
  - Include a subsystem routing table: frontend, backend, runner, GitHub workspaces, Pi auth/packages/skills, testing, deployment, styling.
  - Include "read these before changing X" guidance.

- [x] 4. **Create an LLM reading protocol** - easy
  - Add a focused page such as `docs/llm-reading-protocol.md`.
  - Define how agents should choose docs, when to read raw notes, and when to stop reading.
  - Include guidance for resolving stale or conflicting docs.

- [x] 5. **Create an LLM wiki update protocol** - easy
  - Add a focused page such as `docs/wiki-update-protocol.md`.
  - Define when docs must be updated, how to choose the page, and how to keep edits scoped.
  - Include a checklist for architecture/runtime/deployment/UI workflow changes.

- [x] 6. **Add docs page templates** - easy
  - Add `docs/templates/wiki-page.md`.
  - Include fields for purpose, read-when, canonical owner, related code paths, related docs, and last verified assumptions.
  - Include a short subsystem-page template and a decision-note template.

- [x] 7. **Add local agent skills for wiki usage** - medium
  - Create `.agents/skills/read_developer_wiki/SKILL.md`.
  - Create `.agents/skills/update_developer_wiki/SKILL.md`.
  - The read skill should route agents through `docs/README.md` and focused subsystem docs.
  - The update skill should enforce the wiki update protocol and discourage broad rewrites.

- [x] 8. **Create a subsystem map page** - medium
  - Add or refactor a page that maps major code areas to docs and runtime responsibilities.
  - Include `src/`, `functions/`, `session-runner/`, Firebase config/rules, GitHub Actions, `community/`, and `adrs/`.
  - Keep it shorter than `app-overview.md`; link deeper pages instead of duplicating them.

- [x] 9. **Split or slim `docs/app-overview.md`** - medium
  - Keep it as a concise product/system overview.
  - Move detailed backend/frontend/runtime/deployment sections into focused pages where they belong.
  - Remove stale "planned" language for implemented package/extension behavior.

- [x] 10. **Create or repair focused architecture pages** - medium
  - Ensure canonical pages exist for frontend architecture, backend/API architecture, session runner architecture, deployment, testing, and styling.
  - Create `docs/css-decomposition.md` or remove/replace references to it.
  - Link each focused page from `docs/README.md`.

- [x] 11. **Normalize cross-links and related-doc sections** - medium
  - Add consistent "Related docs" sections to active wiki pages.
  - Link ADRs from relevant active docs instead of requiring agents to discover them manually.
  - Make historical task lists discoverable only through an archive note.

- [x] 12. **Separate active knowledge from raw/historical notes** - medium
  - Move or relabel any remaining planning/task-list material that should not be treated as current architecture.
  - Keep useful raw notes accessible from active pages when they explain why a decision exists.
  - Do not delete historical material unless it is clearly duplicate junk.

- [x] 13. **Add docs validation** - medium
  - Add a lightweight local check for broken relative links in `docs/`, `adrs/`, and `AGENTS.md`.
  - Include the check in the maintenance docs or root verification task once stable.
  - Avoid external network requirements.

- [x] 14. **Update `AGENTS.md` to use the wiki** - easy
  - Point agents at `docs/README.md` as the developer-wiki entrypoint.
  - Reference the read/update wiki skills once they exist.
  - Keep the existing docs/community ownership boundary.

- [x] 15. **Review docs for stale implementation claims** - medium
  - Search for "planned", "future", "current", and old file paths.
  - Verify claims against the current tree before editing.
  - Create follow-up tasks for anything that requires code knowledge beyond docs cleanup.

- [x] 16. **Finalize the phase 2 handoff checklist** - easy
  - Mark completed wiki tasks.
  - List remaining docs uncertainties.
  - Record the expected workflow for future agents: read wiki, change code, update wiki, run docs validation.

## Phase 2 Handoff

Completed: 2026-06-17 - Refactored `docs/` into an active developer wiki with entrypoint routing, reading/update protocols, templates, local wiki skills, subsystem map, focused frontend/backend/runtime/deployment/styling pages, ADR index, archive note, link validation, and updated agent instructions.

Remaining docs uncertainties:

- `docs/pi-extension-manager.md` still records open implementation decisions for package cache archive shape, operation persistence, Pi package API integration, user-scoped package detail, and whether `.pi/settings.json` should be hidden in Files UI.
- ADRs still contain historical "planned/future" wording by design; do not rewrite accepted decision history unless superseding it with a new decision note or ADR.
- Historical task lists under `docs/prior_task_lists/` still mention old paths and plans by design; use active wiki pages for current architecture.

Expected future workflow:

1. Read `docs/README.md`.
2. Follow `docs/llm-reading-protocol.md` to choose focused subsystem docs.
3. Change code or docs in the owning subsystem.
4. Follow `docs/wiki-update-protocol.md` before handoff.
5. Run `npm run docs:check` for docs edits and `npm run check` for full local verification when feasible.

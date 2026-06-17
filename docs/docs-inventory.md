# Docs Inventory

## Purpose

This page classifies every file under `docs/` and `adrs/` as of 2026-06-17 and records the link issues found during the wiki refactor.

## Classification

| File | Classification | Notes |
| --- | --- | --- |
| `docs/README.md` | Active wiki | Wiki entrypoint and routing table. |
| `docs/app-overview.md` | Active wiki | Concise product/system overview. |
| `docs/backend-api-architecture.md` | Active wiki | Backend API, Firestore ownership, Cloud Run provisioning owner map. |
| `docs/css-decomposition.md` | Active wiki | CSS ownership and migration protocol. |
| `docs/decisions.md` | Active wiki | ADR index; ADR bodies remain in `adrs/`. |
| `docs/deployment.md` | Active wiki | Firebase, Cloud Functions, Cloud Run, and service account deploy notes. |
| `docs/docs-inventory.md` | Active wiki | Inventory and classification record. |
| `docs/frontend-architecture.md` | Active wiki | Frontend state, workflows, React shell, and component ownership. |
| `docs/github-workspaces.md` | Active wiki | GitHub workspace source-of-truth and session model. |
| `docs/llm-reading-protocol.md` | Active wiki | Agent routing and stopping protocol. |
| `docs/pi-extension-manager.md` | Active wiki | Pi package manager architecture and current implementation contract. |
| `docs/pi-skills-manager.md` | Active wiki | Pi skills manager architecture and current implementation contract. |
| `docs/runtime-containers.md` | Active wiki | Runtime image, terminal, preview, sync, and runner behavior. |
| `docs/session-runner-architecture.md` | Active wiki | Short runner module map and responsibilities. |
| `docs/subsystem-map.md` | Active wiki | Major code area to doc/runtime responsibility map. |
| `docs/testing.md` | Active wiki | Test pyramid and verification commands. |
| `docs/ui-components.md` | Active wiki | UI component index. |
| `docs/wiki-update-protocol.md` | Active wiki | Docs update requirements. |
| `docs/STYLE_GUIDE.md` | Active wiki | Styling and UI implementation standards. |
| `docs/guides/github-app-setup.md` | Active setup guide | Operational setup guide for the GitHub App. |
| `docs/guides/github-connection-metadata-schema.md` | Active reference guide | Firestore schema reference for GitHub connections. |
| `docs/guides/github-workspace-regression-checklist.md` | Active reference asset | Manual regression checklist. |
| `docs/templates/wiki-page.md` | Generated/reference asset | Template for future wiki pages. |
| `docs/tools.png` | Generated/reference asset | Image asset retained in docs tree. |
| `docs/prior_task_lists/github-connectivity.md` | Historical archive | Prior implementation plan; not active architecture. |
| `docs/prior_task_lists/mapache-tools-landing-page-brief.md` | Historical archive | Prior landing-page brief. |
| `docs/prior_task_lists/README.md` | Historical archive | Archive note and routing warning. |
| `docs/prior_task_lists/task_list.spring-cleaning.md` | Historical archive | Completed maintenance task list. |
| `docs/prior_task_lists/workspace-local-pi-extension-manager.md` | Historical archive | Prior Pi extension manager task list. |
| `adrs/adr-0001-github-app-ownership-and-permissions.md` | Historical decision archive | Accepted ADR indexed from `docs/decisions.md`. |
| `adrs/adr-0002-pr-creation-and-branch-naming-policy.md` | Historical decision archive | Accepted ADR indexed from `docs/decisions.md`. |

## Link Findings

Initial scan findings fixed during this refactor:

- `docs/app-overview.md` referenced missing `docs/css-decomposition.md`.
- `docs/github-workspaces.md` linked to `../../adrs/...` from inside `docs/`, which escaped the repository root.
- `docs/github-workspaces.md` linked to an absolute local `task_list.md` path.
- `docs/guides/github-app-setup.md` linked to `../task_list.md`, but the active task list is at the repository root.

`npm run docs:check` is now the local source of truth for broken relative Markdown links in `docs/`, `adrs/`, and `AGENTS.md`.

## Related Docs

- [LLM reading protocol](./llm-reading-protocol.md)
- [Wiki update protocol](./wiki-update-protocol.md)

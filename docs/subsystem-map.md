# Subsystem Map

## Purpose

This page maps major repository areas to their runtime responsibilities and canonical docs. It is intentionally shorter than [app-overview.md](./app-overview.md).

## Read When

Read this when deciding which files and docs own a change.

## Map

| Area | Responsibility | Canonical docs |
| --- | --- | --- |
| `src/` | Vite/React frontend, Firebase Auth startup, app state, workflows, UI components, styling imports. | [Frontend architecture](./frontend-architecture.md), [UI components](./ui-components.md), [Style guide](./STYLE_GUIDE.md) |
| `functions/` | Cloud Functions API, Firebase Admin setup, authenticated workspace/session routes, Cloud Run provisioning, GitHub/Pi proxy services. | [Backend API architecture](./backend-api-architecture.md), [Deployment](./deployment.md) |
| `session-runner/` | Cloud Run runner images and server code for terminal, preview, Git, Pi skills/packages, workspace restore/sync. | [Runtime containers](./runtime-containers.md), [Session runner architecture](./session-runner-architecture.md) |
| Firebase config and rules | Hosting rewrites, Function deployment config, Firestore/Storage rules and indexes. | [Deployment](./deployment.md), [Testing](./testing.md) |
| `.github/workflows/` | Firebase preview and production CI/deploy workflows. | [Deployment](./deployment.md), [Testing](./testing.md) |
| `community/` | User-facing Docusaurus docs/blog under `/community/**`. Out of scope for developer-wiki cleanup unless explicitly requested. | [Deployment](./deployment.md) |
| `adrs/` | Accepted decision records. Bodies remain outside `docs/`; use the wiki index for discovery. | [Decisions](./decisions.md) |
| `.agents/skills/` | Repo-local agent skills for wiki reading/updating and task automation. | [LLM reading protocol](./llm-reading-protocol.md), [Wiki update protocol](./wiki-update-protocol.md) |

## Related Docs

- [App overview](./app-overview.md)
- [Docs inventory](./docs-inventory.md)
- [Decisions](./decisions.md)

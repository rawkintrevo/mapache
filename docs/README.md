# Mapache Developer Wiki

This is the entrypoint for developer-facing and agent-facing knowledge about Mapache Tools. Read this before changing non-trivial behavior, then follow only the focused pages for the subsystem you are touching.

## Purpose

Mapache Tools is a Firebase and Cloud Run app for browser-managed cloud terminal sessions. The active app lets authenticated users create blank or GitHub-backed workspaces, start isolated Cloud Run runner sessions, work in a browser terminal, manage Pi auth/skills/packages, and sync workspace state through Cloud Storage and GitHub.

## How to Read This Wiki

1. Read this page.
2. Read [LLM reading protocol](./llm-reading-protocol.md) for routing and stopping rules.
3. Read the subsystem page(s) in the table below.
4. Read raw notes, ADRs, or historical task lists only when the active page points you there or the current task needs implementation history.
5. After changing behavior, follow [wiki update protocol](./wiki-update-protocol.md).

## Subsystem Routing

| Change area | Read first | Then read when relevant |
| --- | --- | --- |
| Product shape, workspace/session workflow, ownership model | [App overview](./app-overview.md) | [Subsystem map](./subsystem-map.md), [GitHub workspaces](./github-workspaces.md) |
| Frontend state, React shell, app workflows | [Frontend architecture](./frontend-architecture.md) | [UI components](./ui-components.md), [Style guide](./STYLE_GUIDE.md) |
| Backend API, Cloud Functions, Firestore ownership | [Backend API architecture](./backend-api-architecture.md) | [GitHub workspaces](./github-workspaces.md), [GitHub connection metadata schema](./guides/github-connection-metadata-schema.md) |
| Runtime container images, PTY, terminal, preview, workspace sync | [Runtime containers](./runtime-containers.md) | [Session runner architecture](./session-runner-architecture.md) |
| GitHub-backed workspaces, repo picker, PR behavior | [GitHub workspaces](./github-workspaces.md) | [ADR index](./decisions.md), [GitHub App setup guide](./guides/github-app-setup.md) |
| Pi auth, packages, skills | [Pi skills manager](./pi-skills-manager.md), [Pi extension manager](./pi-extension-manager.md) | [Runtime containers](./runtime-containers.md) |
| Testing and local verification | [Testing](./testing.md) | [Wiki update protocol](./wiki-update-protocol.md) |
| Deployment, Firebase Hosting, Cloud Functions, Cloud Run service accounts | [Deployment](./deployment.md) | [Runtime containers](./runtime-containers.md), [Testing](./testing.md) |
| Styling, CSS ownership, component sidecars | [Style guide](./STYLE_GUIDE.md) | [CSS decomposition](./css-decomposition.md), [UI components](./ui-components.md) |

## Canonical Versus Historical

Active wiki pages under `docs/` are the current source of truth unless they explicitly say they are raw notes or planning material. ADRs under `adrs/` are accepted decision records and are indexed from [decisions.md](./decisions.md). Historical implementation plans remain under [prior_task_lists](./prior_task_lists/) and should not be treated as current architecture.

When active docs disagree with code, verify against the current tree and update the relevant active page in the same change. When active docs disagree with each other and the correct behavior is not obvious, record the uncertainty in the closest active page or `task_list.md` rather than silently choosing a truth.

## Maintenance Checks

Run the docs link checker after wiki edits:

```bash
npm run docs:check
```

`npm run check` includes the same docs check before code tests and builds.

## Related Docs

- [LLM reading protocol](./llm-reading-protocol.md)
- [Wiki update protocol](./wiki-update-protocol.md)
- [Subsystem map](./subsystem-map.md)
- [Docs inventory](./docs-inventory.md)

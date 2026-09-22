# Mapache Developer Wiki

This is the entrypoint for developer-facing and agent-facing knowledge about Mapache Tools. Read this before changing non-trivial behavior, then follow only the focused pages for the subsystem you are touching.

## Purpose

Mapache Tools is a Firebase and Cloud Run app for browser-managed cloud agent sessions. The active app lets authenticated users create blank or GitHub-backed workspaces, start an isolated managed `pi-chrome` runner, work in the embedded upstream agent UI, use sibling terminal/Chrome/Preview surfaces, manage credentials and external connections, and persist workspace/agent state through Cloud Storage and GitHub.

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
| Scheduled workspace automations, queueing, GCS inputs/outputs, and release gate | [Scheduled Automations](./automations.md) | [Backend API architecture](./backend-api-architecture.md), [Runtime containers](./runtime-containers.md), [Deployment](./deployment.md), [Testing](./testing.md) |
| Backend API, Cloud Functions, Firestore ownership | [Backend API architecture](./backend-api-architecture.md) | [GitHub workspaces](./github-workspaces.md), [GitHub connection metadata schema](./guides/github-connection-metadata-schema.md) |
| Native upstream Goals and paused-goal persistence | [Workspace Goals](./workspace-goals.md) | [Backend API architecture](./backend-api-architecture.md), [Runtime containers](./runtime-containers.md), [Runner harnesses](./runner-harnesses.md) |
| Google Workspace MCP connections and OAuth | [Google Workspace MCP connectivity](./google-workspace-connectivity.md) | [Backend API architecture](./backend-api-architecture.md), [Runtime containers](./runtime-containers.md), [Deployment](./deployment.md) |
| Runtime container images, PTY, terminal, preview, workspace sync | [Runtime containers](./runtime-containers.md) | [Session runner architecture](./session-runner-architecture.md) |
| Runner harness catalog, auth/skills/subagents capability routing, shared image metadata | [Runner harnesses](./runner-harnesses.md) | [Runtime containers](./runtime-containers.md), [Backend API architecture](./backend-api-architecture.md), [Frontend architecture](./frontend-architecture.md) |
| SSH-backed dev-machine sessions and signed-key setup | [Runtime containers](./runtime-containers.md) | [SSH-backed sessions guide](./guides/ssh-backed-sessions.md), [Backend API architecture](./backend-api-architecture.md) |
| GitHub-backed workspaces, repo picker, PR behavior | [GitHub workspaces](./github-workspaces.md) | [ADR index](./decisions.md), [GitHub App setup guide](./guides/github-app-setup.md) |
| Pi auth and upstream agent settings | [Runner harnesses](./runner-harnesses.md) | [Runtime containers](./runtime-containers.md), [Frontend architecture](./frontend-architecture.md) |
| Testing and local verification | [Testing](./testing.md) | [Wiki update protocol](./wiki-update-protocol.md) |
| Deployment, Firebase Hosting, Cloud Functions, Cloud Run service accounts | [Deployment](./deployment.md) | [Runtime containers](./runtime-containers.md), [Testing](./testing.md) |
| Styling, CSS ownership, component sidecars | [Style guide](./STYLE_GUIDE.md) | [CSS decomposition](./css-decomposition.md), [UI components](./ui-components.md) |

## Canonical Versus Historical

The [pi-web-ui sequential checklist](../task_list.md) is the implementation and
release record for the single-runner integration. Its [execution guide](./plans/pi-web-ui-tasks/README.md)
fixes the implementation boundaries and stop rules. Completed task notes are
historical evidence; the active subsystem pages below describe current runtime
behavior.

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

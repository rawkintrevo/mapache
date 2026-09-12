# Retired Mapache Extension Manager

The former Mapache web extension/package manager was retired in Task 33. Its
old Functions proxies, runner package routes, frontend panel, package catalog,
and package mutation workflows are not part of the current runtime.

Pi/agent extensions remain upstream-owned. Users can configure supported
extensions through the embedded upstream Agent application or the terminal.
Mapache may still preserve package/cache directories as archive-backed runtime
state when they are part of an existing workspace, but it does not list,
install, update, or remove them through a parent API.

Do not restore the old manager to solve a persistence problem. Workspace files,
agent history, UI state, and native settings are restored through the versioned
checkpoint flow described in [Runtime containers](./runtime-containers.md).
Credential and connector configuration remains in Mapache-owned Authentication
Center, MCP, Google Workspace, and GitHub workflows.

The detailed implementation plan is retained under
`docs/prior_task_lists/workspace-local-pi-extension-manager.md` for historical
context only.

## Related docs

- [Frontend architecture](./frontend-architecture.md)
- [Backend API architecture](./backend-api-architecture.md)
- [Runner harnesses](./runner-harnesses.md)
- [Runtime containers](./runtime-containers.md)

# Upstream Agent Skills

Mapache no longer provides a parent-shell skill CRUD manager. Task 33 removed
the duplicate skills UI/API/runner control routes. Supported skills remain
owned and configured by the upstream Agent application and by the terminal
workflows of the selected agent.

The runner may seed missing Mapache-owned guidance files needed for the curated
Chrome, Preview, N64, or GitHub workflows. Seeding is idempotent and never
overwrites user-edited files; it is startup materialization, not a user-facing
skills registry.

Skill files that are part of workspace or agent state are included in the
existing workspace/checkpoint persistence rules. Auth, MCP, Google, and GitHub
connection data remain separate Mapache-owned stores and are not skill files.

The historical manager design and rollout notes remain under
`docs/prior_task_lists/` and must not be used as the current API contract.

## Related docs

- [Runner harnesses](./runner-harnesses.md)
- [Runtime containers](./runtime-containers.md)
- [Frontend architecture](./frontend-architecture.md)

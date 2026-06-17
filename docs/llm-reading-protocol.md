# LLM Reading Protocol

## Purpose

This page tells agents how to choose wiki context without reading every file in the repository.

## Read When

Read this page after [README](./README.md) and before starting non-trivial code, runtime, deployment, or docs work.

## Protocol

1. Start from [README](./README.md).
2. Use the routing table to choose one or two subsystem pages.
3. Read linked ADRs only when the subsystem page says the decision affects the task.
4. Read guides when the task changes setup, credentials, deployment, or manual operations.
5. Read historical task lists only for implementation history. Do not treat them as active requirements.
6. Stop reading when the needed owner, code paths, invariants, and verification commands are clear.

## Raw Notes And Archives

`docs/prior_task_lists/` is archive-only. It may explain why a change happened, but current behavior belongs in active wiki pages. The `adrs/` directory is accepted decision history and remains outside `docs/`; use [decisions.md](./decisions.md) as its wiki index.

## Stale Or Conflicting Docs

When docs appear stale:

- Verify the claim against current source files, package scripts, Firebase config, or tests.
- Prefer current code for implemented behavior.
- Prefer ADRs for accepted product or architecture decisions unless a later active page explicitly supersedes them.
- Update the active page if the task changes or confirms the truth.
- Add a follow-up note if resolving the conflict needs product or architecture input.

## Related Docs

- [Wiki update protocol](./wiki-update-protocol.md)
- [Docs inventory](./docs-inventory.md)
- [Subsystem map](./subsystem-map.md)

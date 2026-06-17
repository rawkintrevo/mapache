---
name: read_developer_wiki
description: Route agents through the Mapache developer wiki before non-trivial implementation work.
---

# Read Developer Wiki

Use this skill before non-trivial changes to Mapache code, runtime behavior, deployment, or developer docs.

## Workflow

1. Read `docs/README.md`.
2. Read `docs/llm-reading-protocol.md`.
3. Use the routing table in `docs/README.md` to choose the focused subsystem docs.
4. Read ADRs only when an active page links them for the current task.
5. Treat `docs/prior_task_lists/` as historical context only.
6. Stop once the relevant owner files, invariants, and verification commands are clear.

## Output Expectations

Before editing, state which wiki pages were read and which code paths they identify as owners.

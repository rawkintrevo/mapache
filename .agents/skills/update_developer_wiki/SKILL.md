---
name: update_developer_wiki
description: Enforce Mapache wiki update requirements after changes that affect architecture, runtime, deployment, or workflow behavior.
---

# Update Developer Wiki

Use this skill before handoff when a change affects Mapache architecture, runtime behavior, deployment, UI workflow, or recorded decisions.

## Workflow

1. Read `docs/wiki-update-protocol.md`.
2. Update the canonical subsystem page named by `docs/README.md`.
3. Keep edits scoped to the changed behavior.
4. Add related-doc links instead of duplicating long explanations.
5. Leave historical task lists under `docs/prior_task_lists/`.
6. Do not move developer maintenance notes into `community/`.
7. Run `npm run docs:check`.

## Output Expectations

Report which wiki pages changed and whether `npm run docs:check` passed.

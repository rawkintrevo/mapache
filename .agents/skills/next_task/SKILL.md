---
name: next-task
description: Use when the user says "next task" or asks to continue an ordered implementation checklist from /task_list.md at the repository root. Select the next incomplete task, implement it, mark it complete, test, commit when possible, and report the next task.
---

# Next Task Workflow

Use this skill whenever the user says `next task`, asks to continue the plan, or asks what to work on next.

## Before starting a new task

1. Compact or summarize the current conversation context before selecting work so the next task starts with a clean, task-focused context window. Preserve: current task state, blockers, test state, uncommitted changes, relevant credentials/secrets location (not secret values), and the next unchecked task.
2. After compacting, continue with the source-document reads below.

## Source documents

1. Read `/task_list.md` at the repository root for the ordered task checklist, task notes, and acceptance criteria.
2. If present, read `AGENTS.md` for current project conventions.
3. If `/task_list.md` references other project docs, read only the relevant referenced sections before implementing the selected task.

## Selecting work

1. Find the first unchecked task in `/task_list.md`, using checklist items formatted like `- [ ] N. **Task name** - difficulty`.
2. Treat tasks as chronological. Do not skip ahead unless the next task is already complete, blocked, impossible in the current environment, or the user explicitly directs a different task.
3. If a task is blocked, add a short indented `Blocked:` note beneath it in `/task_list.md`, leave it unchecked, report the blocker, and ask the user whether to skip or resolve it.
4. If a task is too large, split it into smaller subtasks directly below that task in `/task_list.md`, but keep the original task unchecked until its acceptance criteria are satisfied.

## Implementing the task

1. Follow `AGENTS.md` when it exists; otherwise infer conventions from nearby code and project docs.
2. Keep files small and single-purpose.
3. Prefer existing architectural boundaries, helpers, and test patterns over new abstractions.
4. Keep secrets and user credentials out of source-controlled files. Follow the target repo's documented secret handling when available.
5. Add relevant automated regression coverage in the same task for new or changed behavior. Do not retroactively test old work unless touched. If tests are impractical, document why and prefer adding a small test seam over skipping.
6. Run relevant test command(s), then existing lint/build checks, before marking the task complete.
7. Do not deploy as part of this skill unless the user explicitly asks for deployment in the current request. If deployment is requested, follow the target repo's own deployment docs or the appropriate deployment-specific skill.

## Marking completion

When the selected task is complete:

1. Update `/task_list.md` by changing the task checkbox from `- [ ]` to `- [x]`.
2. Add a short indented `Completed:` note with the date and a concise summary when helpful.
3. Do not mark a task complete if tests or acceptance checks fail, unless the user explicitly accepts the failure.

## Committing

After completing and marking the task:

1. Review `git status --short`.
2. Stage only files relevant to the completed task. Do not stage unrelated user changes.
3. Commit with a concise message that references the task number and goal, for example:
   `Task 12: add authenticated API baseline`
4. If the target project is not a Git repository, commit access is unavailable, or committing is inappropriate for the current environment, report the exact reason and leave the working tree state clear.

## Final response

End every task run with:

1. **Goal:** restate the user/requested task goal.
2. **Completed:** summarize what changed.
3. **Tests:** summarize automated/manual checks and any skipped QA reason.
4. **Commit:** provide the commit hash or explain why there is no commit.
5. **Next task:** list the next unchecked task with its difficulty.

The user should be able to continue by saying only `next task`.

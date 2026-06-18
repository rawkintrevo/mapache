---
name: issue-workflow
description: "Use when the user provides a GitHub issue number and wants Codex to complete the whole implementation workflow: update local main from remote, read the issue and comments, create an issue-named branch, implement and test the change, run QA for significant frontend changes, commit, push, open a pull request, and comment or label the issue when blocked or waiting on user action."
---

# Issue Workflow

Use this skill to turn a GitHub issue number into a branch, tested implementation, pushed commits, and a pull request.

## Prerequisites

1. Identify the issue number from the user request. If the issue number is missing, ask for it.
2. Use the GitHub plugin/app when available for issue, comment, PR, and label operations. Use `gh` as a fallback when the plugin cannot provide the needed action.
3. Before non-trivial implementation work in this repo, follow the local developer-wiki skill or `AGENTS.md` instructions.
4. Preserve unrelated worktree changes. Do not reset, checkout, or overwrite files unless they are clearly part of this issue or the user explicitly approves.

## Start From Main

1. Inspect the worktree with `git status --short`.
2. If unrelated local changes exist, keep them intact. If they block switching branches, stop and ask the user how to proceed.
3. Check out `main`.
4. Update it from remote with `git pull --ff-only` unless the repo documents a different mainline flow.
5. Read the issue title, body, labels, linked references, and all comments before planning the change.

## Branch Naming

1. Derive a short kebab-case description from the issue title, using lowercase letters, digits, and hyphens.
2. Create a local branch named `<issue-number>-<kebab-case-desc>`, for example `35-admin-panel`.
3. If the exact branch already exists, inspect it and continue there only if it is clearly for the same issue. Otherwise choose a unique suffix such as `35-admin-panel-2`.

## Implementation

1. Implement the issue according to existing project structure and conventions.
2. Keep changes scoped to the issue. Avoid unrelated refactors.
3. Add or update automated tests for the changed behavior.
4. For major frontend changes, add or update a QA test and run it. Verify the browser console has no unexpected errors. Keep the QA screenshots for the PR.
5. Run the relevant build, lint, unit, integration, and QA commands for the touched areas.

## User Action Needed

If completing the issue requires something only the user can do, such as changing a setting in a web UI or granting access:

1. Commit the useful local changes made so far.
2. Push the branch.
3. Comment on the GitHub issue with:
   - What was completed.
   - The branch name.
   - The exact action the user must take.
   - How to resume after the action is done.
4. Stop after reporting the branch, commit, and issue comment.

## Blocked Handling

Treat the work as blocked only after trying to solve the same concrete problem three times without meaningful progress.

When blocked:

1. Commit any useful diagnostic or partial changes that should be preserved. Do not commit broken churn that would confuse the next agent.
2. Push the branch.
3. Comment on the GitHub issue with:
   - The branch name.
   - The blocker.
   - The three attempts made and what happened.
   - Relevant logs, errors, commands, or links.
   - The next decision or access needed.
4. Add the `blocked` label to the issue.
5. Stop and report the block clearly to the user.

## Completion

When implementation is complete and checks pass:

1. Review `git status --short` and `git diff` to confirm only issue-related changes are included.
2. Commit with a concise message referencing the issue, for example `Issue 35: add admin panel`.
3. Push the branch.
4. Open a pull request against `main`.
5. Link the issue in the PR description. Include:
   - Summary of changes.
   - Tests and QA commands run.
   - QA screenshot paths or uploaded screenshots when frontend QA was run.
   - Any known limitations or follow-up work.
6. If a QA screenshot was produced, use it in the PR rather than merely mentioning it.

## Final Response

End with:

1. Issue number and branch.
2. PR link, or issue comment link if blocked or waiting on user action.
3. Commit hash.
4. Tests and QA run, including screenshot paths when applicable.
5. Any remaining user action or residual risk.

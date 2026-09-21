---
name: issue-workflow
description: "Use for actionable GitHub implementation requests: create or reuse an issue, prepare a separate working branch, implement and test, commit, push, open a pull request, and handle explicit hotfix/direct-main exceptions."
---

# Issue Workflow

Use this skill to turn an actionable implementation request into an issue, separate working branch, tested commit, and pull request. Reuse a supplied issue; otherwise search for duplicates and create a scoped issue before editing.

An explicit `hotfix` description or explicit instruction to work `directly on main` uses **Hotfix Or Direct Main** instead. Do not infer that exception from urgency, task size, or the word "fix" alone.

## Prerequisites

1. Identify an issue number supplied by the user. If none is supplied for an authorized implementation, inspect relevant context, clarify ambiguity, search open and closed issues, and create a scoped issue before editing. Do not create issues for explanation, investigation, review, or issue-only requests without implementation authorization.
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

1. Always derive a short kebab-case description from the issue title and create a branch named `<issue-number>-<kebab-case-description>` from the updated `main`.
2. If the exact branch already exists locally or remotely, stop and ask for a different description unless repository policy explicitly defines another collision strategy.

## Implementation

1. Implement the issue according to existing project structure and conventions.
2. Keep changes scoped to the issue. Avoid unrelated refactors.
3. Add or update automated tests for the changed behavior.
4. If the issue changes frontend code, styling, user-visible UI state, navigation, or browser workflow behavior, follow the **Frontend QA Requirement** below.
5. Run the relevant build, lint, unit, integration, and QA commands for the touched areas.

## Frontend QA Requirement

When frontend behavior is changed during this issue workflow:

1. Use the `qa-test` skill before completion.
2. Add or update checked-in QA case manifests under `e2e/qa/cases/` when existing cases do not cover the changed user path. Compose existing `useCase` and `useScript` steps instead of duplicating login/setup.
3. Run the relevant QA case with Chrome DevTools against a local dev server.
4. Treat unexpected browser console errors, failed deterministic assertions, missing expected UI, failed network calls, or broken screenshots as issues to fix before opening the PR.
5. Re-run the QA case after fixes until no issues are found.
6. Store screenshots and other evidence under `artifacts/qa/<case-id>/`.
7. Add the QA screenshots to the PR description or a PR comment. If the available GitHub tool cannot upload screenshots, do not silently omit them: include the local artifact paths in the PR and clearly note the upload limitation in the PR and final response.
8. If QA cannot run because credentials, Chrome DevTools, or another required external setup is missing, treat the workflow as **User Action Needed** or **Blocked Handling** instead of opening a normal completion PR.

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
5. Follow **Final Branch State** before the final response.

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
6. Follow **Final Branch State** before the final response.

## Hotfix Or Direct Main

Use this exception only when the user explicitly calls the implementation a `hotfix` or explicitly instructs you to work `directly on main`.

1. Preserve unrelated work and stop if it prevents a safe checkout.
2. Fetch the canonical remote, check out `main`, and run `git pull --ff-only`.
3. Implement, document, and test with the same quality requirements as normal work.
4. Commit the scoped files directly on `main` and push `main`.
5. Do not create an issue, branch, or pull request unless separately requested.
6. Never force-push or bypass branch protection; report a rejected push as blocked.
7. Report the commit, checks, push outcome, deployment outcome, and final branch.

## Completion

When implementation is complete and checks pass:

1. Review `git status --short` and `git diff` to confirm only issue-related changes are included.
2. Commit with a concise message referencing the issue, for example `Issue 35: add admin panel`.
3. Push the branch.
4. Open a pull request against `main`.
5. Link the issue in the PR description. Include:
   - Summary of changes.
   - Tests and QA commands run.
   - Uploaded QA screenshots, or screenshot artifact paths plus an explicit upload limitation when screenshots could not be uploaded.
   - Any known limitations or follow-up work.
6. If a QA screenshot was produced and upload support is available, embed or attach it in the PR rather than merely mentioning it.

## Final Branch State

Before the final response after completion, user-action pause, or blocked bailout:

1. Ensure useful issue-related changes have been committed and pushed, or intentionally left uncommitted only when blocked before a meaningful commit can be made.
2. Inspect `git status --short`.
3. Return to `main` after publishing when safe. If local changes would block switching, do not stash, reset, delete, or overwrite them automatically; report the branch and blocking paths.

## Final Response

End with:

1. Issue number and branch.
2. PR link, or issue comment link if blocked or waiting on user action.
3. Commit hash.
4. Tests and QA run, including screenshot paths when applicable.
5. Final local branch state, including whether the runner automation branch was preserved or cleanup returned to `main`.
6. Any remaining user action or residual risk.

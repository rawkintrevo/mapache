---
name: issue-workflow
description: "Use when the user provides a GitHub issue number and wants Codex to complete the whole implementation workflow: update local main from remote, read the issue and comments, create an issue-named branch, implement and test the change, compose and run QA for frontend changes, commit, push, open a pull request, return to main, and comment or label the issue when blocked or waiting on user action."
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
7. Copy review-safe QA screenshots into a tracked PR asset path before the final implementation commit, such as `docs/pr-assets/issue-<issue-number>/<case-id>-<name>.png`. Do not copy screenshots that contain secrets, tokens, private customer data, or other sensitive content; redact or recapture them first.
8. Embed the tracked screenshot asset in the PR body using a GitHub-renderable image URL or relative Markdown image. Keep non-image logs, snapshots, traces, and result JSON under `artifacts/qa/<case-id>/` and list those local paths in the PR only when useful.
9. If the available GitHub tool cannot upload arbitrary local screenshots, do not fall back to listing only local screenshot paths. Prefer the tracked PR asset approach above so reviewers can see screenshots inline.
10. If QA cannot run because credentials, Chrome DevTools, or another required external setup is missing, treat the workflow as **User Action Needed** or **Blocked Handling** instead of opening a normal completion PR.

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
5. Follow **Return To Main** before the final response.

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
6. Follow **Return To Main** before the final response.

## Completion

When implementation is complete and checks pass:

1. Review `git status --short` and `git diff` to confirm only issue-related changes are included.
2. Commit with a concise message referencing the issue, for example `Issue 35: add admin panel`.
3. Push the branch.
4. Open a pull request against `main`.
5. Link the issue in the PR description. Include:
   - Summary of changes.
   - Tests and QA commands run.
   - Embedded QA screenshots from tracked PR assets when browser QA produced screenshots.
   - Local paths for any supporting non-image QA artifacts that remain under `artifacts/qa/<case-id>/`.
   - Any known limitations or follow-up work.
6. If a QA screenshot was produced, verify the PR renders it inline before handoff when possible. If inline rendering cannot be verified, include both the Markdown image reference and the tracked asset path in the PR body and final response.

## Return To Main

Before the final response after completion, user-action pause, or blocked bailout:

1. Ensure useful issue-related changes have been committed and pushed, or intentionally left uncommitted only when the workflow is blocked before a meaningful commit can be made.
2. Inspect `git status --short`.
3. Switch back to `main`.
4. If local changes or untracked files would block switching to `main`, do not stash, reset, delete, or overwrite them automatically. Stop, report the current branch and blocking paths, and tell the user what must be resolved before the branch can be switched.
5. After switching, leave the working tree on `main`; do not pull or otherwise change `main` during cleanup unless the user requested it.

## Final Response

End with:

1. Issue number and branch.
2. PR link, or issue comment link if blocked or waiting on user action.
3. Commit hash.
4. Tests and QA run, including screenshot paths when applicable.
5. Final local branch state, including whether cleanup returned to `main`.
6. Any remaining user action or residual risk.

# Live verification

Initial task: [rawkintrevo/mapache#343](https://github.com/rawkintrevo/mapache/issues/343).
Branch: `343-mapache-git-skill`, based on fetched `origin/main`.

## Observations and iterations

1. Bare `gh api repos/rawkintrevo/mapache` failed with exit 4 and requested login.
2. The same API call with `GH_TOKEN="$GITHUB_AUTOMATION_TOKEN"` succeeded and returned the repository identity and default branch. No interactive login was needed.
3. Issue creation with `gh issue create --repo ... --body-file ...` succeeded. Exact `docs` and `easy` labels were unavailable, so intended labels were recorded in the issue body rather than creating new labels.
4. HTTPS fetch succeeded using `GH_TOKEN` and invocation-local `-c credential.helper= -c 'credential.helper=!gh auth git-credential'`.
5. The original `/workspace` had extensive unrelated modifications. `git worktree add -b 343-mapache-git-skill /tmp/mapache-git-343 refs/remotes/origin/main` created an isolated checkout without switching or stashing the original workspace.
6. The packaged helper successfully read the issue, paginated comments, and remote branch SHA. Offline tests cover token precedence/fallback, argument preservation, Git configuration scope, noninteractive Git, invalid invocation, and command failure propagation.

7. Initial staging failed because `.gitignore` ignores new `.agents/skills/*` directories. Added a narrow `mapache-git` exception, preserving the existing allowlist pattern rather than force-adding ignored content.

8. Scoped commit and authenticated `git push --set-upstream` succeeded. Duplicate-PR lookup returned no matches; explicit `gh pr create --base main --head 343-mapache-git-skill --body-file ...` created [PR #344](https://github.com/rawkintrevo/mapache/pull/344).
9. `gh pr view` confirmed the PR was `OPEN` with base `main`, the intended head branch, and the task commit. `git ls-remote` matched local `HEAD`; the isolated worktree was clean. These notes were then committed and pushed as a follow-up to test updating the same PR rather than creating another.

## Repeatable local checks

From the repository root:

```bash
bash -n .agents/skills/mapache-git/scripts/github.sh
python3 .agents/skills/mapache-git/scripts/test_github.py
npm run docs:check
git diff --check
```

The test uses mocked commands and fake token strings, never live credentials. Real API and push checks are separate and require authorization. No application or runtime files are changed, so frontend QA/build and Cloud Functions deployment are not required.

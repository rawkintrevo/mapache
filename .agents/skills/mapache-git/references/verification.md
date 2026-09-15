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

## Repeatable local checks

From the repository root:

```bash
bash -n .agents/skills/mapache-git/scripts/github.sh
python3 .agents/skills/mapache-git/scripts/test_github.py
npm run docs:check
git diff --check
```

The test uses mocked commands and fake token strings, never live credentials. Real API and push checks are separate and require authorization. No application or runtime files are changed, so frontend QA/build and Cloud Functions deployment are not required.

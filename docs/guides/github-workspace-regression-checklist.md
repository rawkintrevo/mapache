# GitHub Workspace Regression Checklist

## Purpose

Use this checklist before deploying changes that touch GitHub-backed workspaces.

## Workspace behavior

- [ ] Blank workspaces still create, sync, and open normally.
- [ ] One-active-agent-session enforcement still blocks a second Pi/agent GitHub session for the same workspace.
- [ ] A shell session can be created for a GitHub workspace that already has an active Pi/agent session.
- [ ] Public GitHub repos still clone successfully.
- [ ] Exact commit checkout still lands on the requested SHA when one is provided.
- [ ] Cached `.git` archives restore correctly on restart.
- [ ] Deleted worktree files do not reappear from stale cache objects.
- [ ] Ignored paths such as `.git/`, `node_modules/`, build outputs, and `.mapache-internal/` stay out of normal sync.
- [ ] The Git panel still shows status, pull, stage/unstage, commit, push, and open-PR actions for GitHub workspaces.

## Validation commands

```bash
npm run build
npm run docs:check
npm --prefix functions run lint
npm --prefix session-runner run lint
```

## Notes

- Use this checklist for regression review only; it is intentionally shorter than the full design docs.
- Existing Cloud Run services may still need a new revision to pick up runner env or sync-policy changes.

## Related Docs

- [GitHub workspaces](../github-workspaces.md)
- [Runtime containers](../runtime-containers.md)
- [Testing](../testing.md)

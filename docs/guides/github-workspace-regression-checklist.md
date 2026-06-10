# GitHub Workspace Regression Checklist

Use this checklist before deploying changes that touch GitHub-backed workspaces.

## Workspace behavior

- [ ] Blank workspaces still create, sync, and open normally.
- [ ] One-active-session enforcement still blocks a second GitHub session for the same workspace.
- [ ] Public GitHub repos still clone successfully.
- [ ] Exact commit checkout still lands on the requested SHA when one is provided.
- [ ] Cached `.git` archives restore correctly on restart.
- [ ] Deleted worktree files do not reappear from stale cache objects.
- [ ] Ignored paths such as `.git/`, `node_modules/`, build outputs, and `.mapahce-internal/` stay out of normal sync.
- [ ] The Git panel still shows status, pull, stage/unstage, commit, push, and open-PR actions for GitHub workspaces.

## Validation commands

```bash
npm run build
npm --prefix functions run lint
node --check session-runner/server.js
```

## Notes

- Use this checklist for regression review only; it is intentionally shorter than the full design docs.
- Existing Cloud Run services may still need a new revision to pick up runner env or sync-policy changes.

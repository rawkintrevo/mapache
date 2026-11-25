# Restored VM browser profile proof

This maintenance proof checks the locally restored `vm-test` browser archive.
It is separate from signed-in Mapache browser QA and never logs into a service.

Prerequisites:

- Successful archive staging and extraction under
  `artifacts/qa/vm-browser-archive-import/stage/`, including `archive-tree.json`.
- Linux `unshare` user/network namespaces, `google-chrome`, Node and Python 3
  with SQLite support.
- A new output location; the result file is create-only.

Run from the repository root:

```bash
VM_PROOF_PARENT_NETNS="$(readlink /proc/self/ns/net)" \
  unshare --user --map-root-user --net \
  node scripts/vm-browser-profile-proof.mjs
```

An optional first argument selects another output directory for subsequent runs.
The default is `artifacts/qa/vm-browser-profile-proof`.

The script checks its network namespace differs from the caller's and has no
external interfaces, fingerprints the restored source, and copies it into a
private disposable profile. It clears only the copy's stale Singleton locks,
checks JSON settings and SQLite integrity (including available WAL state), and
launches an owned headless Chrome through a private DevTools pipe. It creates
only an `about:blank` target and a synthetic data page. No DevTools TCP port,
Mapache authentication, remote model request or external login is used.

Passing requires the synthetic page to render without page exceptions, Chrome
to exit with code zero, all detected SQLite databases to pass before and after
launch, and the original restored filesystem fingerprint to remain unchanged.
Cleanup stops only the owned process group and removes the disposable profile.
The private result records version, counts and booleans, never database rows,
cookie values, URLs from history or profile member names.

This proves local profile readability and Chrome startup only. It does not
prove the VM's headed desktop/noVNC workflow, sandbox behavior, compatibility
with a different runner Chrome version, encrypted credential recovery, external
authentication or full-machine migration.

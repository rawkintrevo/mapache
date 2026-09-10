# Gate C checkpoint policy

Scope: the opt-in `pi-chrome` runner slice. The policy is implemented in
`session-runner/lib/workspaceCheckpoint.service.js` and remains disabled by
the production image default until Gate A and the platform fencing work pass.

## Commit unit

The runner creates one immutable checkpoint directory:

```text
<PI_SESSION_STORAGE_PREFIX>/epochs/<executionEpoch>/checkpoints/<checkpointId>/
```

It uploads these payloads first with Cloud Storage create-only preconditions
(`ifGenerationMatch: 0`):

- `pi-session.jsonl` — a stable local copy of the current Pi JSONL tree;
- `managed-goal-state.json` — bounded managed-goal state, or an explicit unavailable marker;
- `workspace-snapshot.tar.gz` — the allowlisted workspace and `.git` tree;
- `operation-evidence.json` — the bounded operation ledger and event evidence.

The `manifest.json` is uploaded last. It records schema version, checkpoint
and prior checkpoint IDs, workspace revision, runtime ID, execution epoch,
Pi session/leaf, adapter and package identity, payload generations, SHA-256
hashes, byte lengths, and the snapshot scope. The Firestore transaction then
validates the current execution authority and existing sync-writer
reservation, the prior pointer, and the monotonic workspace revision before
advancing both the session and workspace recovery records.

Uploads are outside the transaction callback. A failed or late upload can
only leave an unreferenced object under its immutable checkpoint path; it
cannot overwrite the committed pointer. Cleanup requires the grace period,
skips every object referenced by the verified current pointer, and refuses to
run while a checkpoint publication is in flight.

## Quiescence and mutation boundary

The mutation barrier rejects new runner-owned writes while a checkpoint is
closing and waits for entered writers to leave. A barrier timeout leaves
admission blocked. Independent Git, Pi package/skill/subagent, and workspace
sync-down mutations require no active web-first run and request a checkpoint
after their local/remote operation completes. Session-scoped model/auth files
are separately authority-gated but excluded from the recovery payload. A
checkpoint failure leaves a checkpointed mutation blocked for inspection.

The barrier does not stop arbitrary processes or browser-side Functions
writes. Those are explicit open Gate C items. The existing Chrome profile
archive is serialized through the same runner writer boundary but remains a
separate archive and is excluded from the workspace recovery pair.

## Archive allowlist

Included paths are ordinary workspace files, `.git` metadata when present,
and the checkpoint payloads listed above. The archive excludes:

- `.env*`, `auth.json`, `credentials.json`, SSH private/known-host files,
  GitHub CLI host credentials, and private-key/certificate suffixes;
- `.mapache-internal`, the historical `.mapahce-internal` spelling, IPC/control
  files, lock files under `.git`, and symbolic links;
- `node_modules`, `.cache`, `.npm`, `.pi/npm`, `.pi/git`, and `.pi/agent`;
- Chrome profile data and browser caches.

The Pi session is copied separately after a stat/read/stat stability check and
its JSONL IDs and parent bindings are validated. The current Gate A adapter
does not expose a canonical session-file export or session replacement hook;
the runner uses an explicitly configured path when available and otherwise
the latest stable JSONL under the session directory. That limitation keeps
C13 and the Gate C exit criteria open.

## Restore contract

Recovery verifies the exact manifest generation and checksum, every payload
generation/length/hash, manifest epoch/runtime bindings, and the Pi tree
before extracting into a staging directory. It never applies a checkpoint to
the live workspace; a requested live-workspace destination is rejected.
Missing, stale, incompatible, or corrupt data stops recovery rather than
falling back to newest-file selection.

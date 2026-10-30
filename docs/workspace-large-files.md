# Large workspace files

Legacy/local workspaces restore files larger than **100 MiB** as small text
pointers at their original paths. Exactly 100 MiB is still restored normally.
The pointer begins with `mapache-large-file-v1` and records SHA-256 and original
byte length. It is a Mapache format, not a Git LFS pointer or Git filter.
Applications must explicitly fetch the contents before opening them as models,
archives, executables, or other binary data:

```bash
mapache files pull artifacts/production-a100-120/export/model.safetensors
```

The command resolves paths relative to the working directory, checks that the
pointer belongs to the current workspace's published checkpoint, rejects symlink
paths, and streams into a temporary file outside the checkpointed workspace.
Only a complete size/hash-verified download replaces the pointer. Failure leaves
the pointer intact. One pull runs at a time per workspace. A crashed pull's lock
is cleared by runner replacement; operators must verify no pull is running before
removing a stale lock manually.

Cloud Run's local filesystem consumes instance memory. Fetching therefore needs
space for the file plus 256 MiB headroom; the command checks cgroup v1/v2 memory
and refuses when it cannot establish that headroom. This is a preflight check,
not a reservation against other running processes. Resize before fetching large
models when necessary. Restart restores large files as pointers again. No automatic
fetch occurs on access, and fetching does not load a model into an application.

## Persistence and existing workspaces

`session-runner/lib/workspaceLargeFiles.js` owns pointer parsing, the fixed default
threshold, streaming uploads, and workspace-scoped content-addressed blobs.
`agentCheckpointRestore.service.js` applies the threshold to **existing version-1
manifests**, so historical large files do not need a destructive migration.
`agentCheckpoint.service.js` recognizes pointers against the trusted previous
manifest and preserves their original contents. Renaming a pointer retains the
blob; deleting it removes the entry from the next manifest while preserving
historical objects. Replacing it with ordinary content intentionally replaces
the file in the next checkpoint. Invalid/unrecognized pointers fail publication.

On the first pointer save, a legacy immutable object is copied server-side into
`{agentSnapshotStoragePrefix}/large-files/v1/sha256/{hash}`. Later checkpoints
reuse the object. New materialized large files upload through a bounded stream
to an unpublished staging object, then copy to their checksum name. Publication
keeps the existing generation/boot fences and compare-and-swap checkpoint pointer.
Failed publication cannot replace the previous checkpoint. Blobs are not individually
garbage-collected by this change; normal workspace deletion owns their lifecycle.

Agent transcripts, private state archives, and shared GCS FUSE workspace mounts
retain their existing behavior. A very large aggregate of sub-threshold files can
still consume substantial memory. This feature addresses individual large artifacts,
not a general filesystem quota.

## Rollout and recovery

Rebuild `Dockerfile.pi-chrome` and restart/recreate existing sessions with the new
revision. The image installs `mapache` from `bin/mapache.js`; the fetch service is
`lib/workspaceLargeFilePull.js`. Trashpanda's existing checkpoint is compatible and
its two large model artifacts restore as pointers without downloading their bytes.
Keep the original checkpoint and blobs intact during recovery.

After publication of a manifest containing `storage: large-file-v1`, older runners
cannot restore that manifest. Rollback must use a compatible runner or a verified
pre-upgrade checkpoint; never roll back the image alone after new publication.

Validation covers the threshold boundary, legacy restore, rename/restart/deletion,
content-addressed reuse, streaming upload, corrupt downloads, tampered pointers,
manifest checksum validation, symlink rejection, and insufficient memory.

Related: [Runtime containers](./runtime-containers.md),
[Session runner architecture](./session-runner-architecture.md).

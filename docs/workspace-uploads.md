# Workspace uploads

The navbar Upload file action in the workspace actions menu
accepts one local file of 1 byte through 1 GiB. Files appear at
`/uploads/<filename>` in main and automation runtimes. The directory is read-only
inside runners; users and agents copy inputs into their writable working directory
when modifications are needed. This is workspace-scoped input storage, not the
owner-wide writable sharing proposed in issue #439.

## Owners and transfer contract

- `functions/workspaceUploads.service.js` owns validation, upload authorization,
  and the Cloud Run volume fragment.
- `POST /api/workspaces/{workspaceId}/uploads` accepts `{name, size}` and returns
  a GCS resumable session URL and filesystem path after workspace ownership and
  deletion checks. Responses use `Cache-Control: no-store`.
- `src/services/workspaceUploads.js` transfers 8 MiB chunks directly from the
  browser to GCS. It queries committed offsets after interrupted responses and
  retries transient failures a bounded number of times. Retry in the open dialog
  resumes the same upload. Reloading the page requires selecting the file again.
- `WorkspaceUploadModal.jsx` owns file selection, progress, retry, and cancellation;
  `AppShell.jsx` owns its lifetime and closes it when the workspace changes.

The backend derives the bucket and `.mapache-internal/uploads` prefix from the
owner-checked workspace record. It rejects path separators, control characters,
invalid lengths and sizes. GCS receives the declared content length and a
create-only generation precondition. Duplicate filenames require renaming the
local file; existing content is never silently overwritten. Upload session URLs
are bearer credentials and remain only in browser memory. Closing an in-progress
dialog aborts the request and attempts to cancel the GCS session. Unfinished GCS
sessions expire; only finalized objects appear in the mount.

## Runtime and lifecycle

`functions/cloudRun.service.js` adds a sibling read-only GCS volume at `/uploads`,
with metadata caching disabled for visibility after upload completion. The existing workspace bucket's runner read permission is reused.
The mount uses the workspace's original storage prefix even when `/workspace`
uses a separate shared-storage bucket. It is outside workspace snapshots, restore,
Git, and sync. Uploads survive runner shutdown, restart, and automation cleanup;
workspace deletion removes them with the workspace's internal storage prefix.

The retained-disk runtime path is implemented by the runner's
`diskUpload.service.js`. The Compute API authorizes the current-generation
gateway URL, then the runner streams bounded chunks directly into the retained
`/uploads` directory. Per-operation state is stored under the retained cache
directory; temporary files use an operation-specific `.part` name, same-operation
writes are serialized, temporary paths reject symlinks, and completed files are
checksum-verified before an atomic rename. Duplicate destinations are rejected,
cancellation removes the temporary state, and `ENOSPC` is reported as the
explicit `upload_storage_full` response while preserving any valid prefix for a
probe or retry.

This does not yet make an upload token valid across VM replacement: a browser
must obtain a new authorized current-generation upload flow after replacement.
Paused-machine UX, replacement/reauthorization behavior, and full real-ingress
failure testing remain part of the #622 acceptance work.

Deploy Functions with `firebase deploy --only functions --project pi-agents-cloud`
and deploy the frontend through the normal Hosting release. The GCS-mounted
Cloud Run path requires no runner image rebuild; changes to the retained-disk
upload service do require a new runner image. Existing sessions need pause/start
to receive a new volume or runner revision. New sessions receive it immediately.
The UI explains this one-time restart requirement; it never restarts active work
automatically. Keep `/runner/health` unchanged.

## Verification

Run Functions tests, frontend tests, `npm run build`, and `npm run docs:check`.
The browser case is `e2e/qa/cases/workspace-uploads.json`; use a disposable QA
workspace, verify a multi-chunk upload and the mounted file's checksum, then clean
up that workspace. Include token-free console/network evidence and screenshots.

## Related docs

- [Runtime containers](./runtime-containers.md)
- [Frontend architecture](./frontend-architecture.md)
- [Backend API architecture](./backend-api-architecture.md)

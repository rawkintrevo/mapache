# Workspace uploads

The navbar Upload file action beside Logs (also in the responsive More menu)
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

Deploy Functions with `firebase deploy --only functions --project pi-agents-cloud`
and deploy the frontend through the normal Hosting release. No runner image rebuild
is required. Existing sessions need pause/start to receive the new volume. New
sessions receive it immediately. The UI explains this one-time restart requirement;
it never restarts active work automatically. Keep `/runner/health` unchanged.

## Verification

Run Functions tests, frontend tests, `npm run build`, and `npm run docs:check`.
The browser case is `e2e/qa/cases/workspace-uploads.json`; use a disposable QA
workspace, verify a multi-chunk upload and the mounted file's checksum, then clean
up that workspace. Include token-free console/network evidence and screenshots.

## Related docs

- [Runtime containers](./runtime-containers.md)
- [Frontend architecture](./frontend-architecture.md)
- [Backend API architecture](./backend-api-architecture.md)

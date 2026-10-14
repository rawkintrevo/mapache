export const MAX_UPLOAD_BYTES = 1024 ** 3;
const CHUNK_BYTES = 8 * 1024 * 1024;

function acknowledgedOffset(response, size) {
  const range = response.headers.get("Range");
  if (!range) return 0;
  const match = /^bytes=0-(\d+)$/.exec(range);
  const offset = match ? Number(match[1]) + 1 : NaN;
  if (!Number.isSafeInteger(offset) || offset > size) throw new Error("Invalid upload acknowledgement.");
  return offset;
}

function uploadError(response) {
  if (response.status === 412) return new Error("A file with this name already exists. Rename your file and try again.");
  if ([404, 410].includes(response.status)) return new Error("Upload expired. Choose the file again to start a new upload.");
  return new Error(`Upload failed (${response.status}). Try again.`);
}

// The session URL is a bearer credential: keep it in memory, never in logs or storage.
export async function uploadWorkspaceFile(file, upload, {signal, onProgress = () => {}, fetchImpl = fetch} = {}) {
  if (!file.size || file.size > MAX_UPLOAD_BYTES) throw new Error("Choose a file between 1 byte and 1 GiB.");
  let offset = 0;
  let failures = 0;
  let probe = true;
  while (true) {
    signal?.throwIfAborted();
    const end = Math.min(offset + CHUNK_BYTES, file.size);
    let response;
    try {
      response = await fetchImpl(upload.uploadUrl, {
        method: "PUT",
        headers: {"Content-Type": "application/octet-stream", "Content-Range": probe ?
          `bytes */${file.size}` : `bytes ${offset}-${end - 1}/${file.size}`},
        body: probe ? new Blob([]) : file.slice(offset, end),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (++failures > 3) throw new Error("Connection interrupted. Retry to resume this upload.");
      probe = true;
      continue;
    }
    if (response.ok) {
      onProgress(100);
      return {path: upload.path};
    }
    if (response.status === 308) {
      const next = acknowledgedOffset(response, file.size);
      if (next <= offset && (!probe || offset === file.size) && ++failures > 3) throw new Error("Upload stalled. Retry to resume.");
      if (next > offset) failures = 0;
      offset = next;
      onProgress(Math.floor(offset / file.size * 100));
      probe = offset === file.size;
      continue;
    }
    if ((response.status === 429 || response.status >= 500) && ++failures <= 3) {
      probe = true;
      continue;
    }
    throw uploadError(response);
  }
}

export async function cancelWorkspaceUpload(upload) {
  if (!upload?.uploadUrl) return;
  try { await fetch(upload.uploadUrl, {method: "DELETE"}); } catch { /* Session expires at GCS if offline. */ }
}

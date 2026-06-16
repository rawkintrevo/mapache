import {getBlob, ref, uploadBytesResumable} from "firebase/storage";

import {getFirebaseStorage} from "./auth.js";

export const DIRECT_WORKSPACE_UPLOAD_THRESHOLD_BYTES = 10 * 1024 * 1024;

export function shouldUploadWorkspaceFileDirect(file) {
  return Number(file?.size || 0) > DIRECT_WORKSPACE_UPLOAD_THRESHOLD_BYTES;
}

export async function uploadWorkspaceFileDirect(workspace, file, onProgress) {
  const storage = getFirebaseStorage();
  const storagePrefix = normalizeStoragePrefix(workspace?.storagePrefix || "");
  const filename = normalizeUploadFilename(file?.name || "");

  if (!storage || !storagePrefix) throw new Error("workspace_storage_not_configured");
  if (!file || !file.size) throw new Error("empty_file_upload");
  if (!filename) throw new Error("invalid_file_path");

  const objectRef = ref(storage, `${storagePrefix}/${filename}`);
  const uploadTask = uploadBytesResumable(objectRef, file, {
    contentType: file.type || "application/octet-stream",
  });

  return new Promise((resolve, reject) => {
    uploadTask.on(
        "state_changed",
        (snapshot) => {
          if (!onProgress || !snapshot.totalBytes) return;
          onProgress({
            bytesTransferred: snapshot.bytesTransferred,
            totalBytes: snapshot.totalBytes,
            percent: Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100),
          });
        },
        (error) => reject(error),
        () => resolve({
          name: filename,
          path: filename,
          size: uploadTask.snapshot.totalBytes,
        }),
    );
  });
}

export async function downloadWorkspaceFileDirect(workspace, path) {
  const storage = getFirebaseStorage();
  const storagePrefix = normalizeStoragePrefix(workspace?.storagePrefix || "");
  const relativePath = normalizeWorkspaceFilePath(path);

  if (!storage || !storagePrefix) throw new Error("workspace_storage_not_configured");
  if (!relativePath) throw new Error("invalid_file_path");

  const objectRef = ref(storage, `${storagePrefix}/${relativePath}`);
  const blob = await getBlob(objectRef);
  return {
    blob,
    filename: relativePath.split("/").pop() || "download",
  };
}

function normalizeStoragePrefix(prefix) {
  return String(prefix).replace(/^\/+|\/+$/g, "");
}

function normalizeUploadFilename(name) {
  const filename = String(name).split(/[/\\]/).pop().trim();
  if (!filename || filename === "." || filename === "..") return "";
  if (filename.includes("/") || filename.includes("\\")) return "";
  return filename;
}

function normalizeWorkspaceFilePath(value) {
  const clean = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!clean || clean.endsWith("/")) return "";
  const parts = clean.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return "";
  return parts.join("/");
}

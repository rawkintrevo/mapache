"use strict";

const DIRECTORY_MARKER_FILE = ".mapache-directory";
const LEGACY_DIRECTORY_MARKER_FILE = ".mapahce-directory";
const DIRECTORY_MARKER_FILES = [
  DIRECTORY_MARKER_FILE,
  LEGACY_DIRECTORY_MARKER_FILE,
];

const INTERNAL_STORAGE_DIR = ".mapache-internal";
const LEGACY_INTERNAL_STORAGE_DIR = ".mapahce-internal";
const INTERNAL_STORAGE_DIRS = [
  INTERNAL_STORAGE_DIR,
  LEGACY_INTERNAL_STORAGE_DIR,
];

function isDirectoryMarkerFileName(value) {
  return DIRECTORY_MARKER_FILES.includes(String(value || ""));
}

function isInternalStorageDirName(value) {
  return INTERNAL_STORAGE_DIRS.includes(String(value || ""));
}

function legacyInternalStoragePathVariants(value) {
  const normalized = String(value || "");
  const legacy = normalized.replace(
      /(^|\/)\.mapache-internal(?=\/|$)/g,
      `$1${LEGACY_INTERNAL_STORAGE_DIR}`,
  );
  if (!legacy || legacy === normalized) {
    return [];
  }
  return [legacy];
}

module.exports = {
  DIRECTORY_MARKER_FILE,
  DIRECTORY_MARKER_FILES,
  INTERNAL_STORAGE_DIR,
  INTERNAL_STORAGE_DIRS,
  LEGACY_DIRECTORY_MARKER_FILE,
  LEGACY_INTERNAL_STORAGE_DIR,
  isDirectoryMarkerFileName,
  isInternalStorageDirName,
  legacyInternalStoragePathVariants,
};

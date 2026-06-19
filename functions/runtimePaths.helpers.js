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

function canonicalizeInternalStoragePath(value) {
  return String(value || "").replace(
      /(^|\/)\.mapahce-internal(?=\/|$)/g,
      `$1${INTERNAL_STORAGE_DIR}`,
  );
}

module.exports = {
  DIRECTORY_MARKER_FILE,
  DIRECTORY_MARKER_FILES,
  INTERNAL_STORAGE_DIR,
  INTERNAL_STORAGE_DIRS,
  LEGACY_DIRECTORY_MARKER_FILE,
  LEGACY_INTERNAL_STORAGE_DIR,
  canonicalizeInternalStoragePath,
  isDirectoryMarkerFileName,
  isInternalStorageDirName,
};

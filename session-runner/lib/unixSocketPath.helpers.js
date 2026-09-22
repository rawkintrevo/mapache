"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

// Leave room for the terminating NUL on Linux and other supported Unix hosts.
const MAX_SOCKET_PATH_BYTES = 100;

function boundedUnixSocketPath(preferredPath) {
  const resolved = path.resolve(preferredPath);
  if (Buffer.byteLength(resolved) <= MAX_SOCKET_PATH_BYTES) return resolved;
  // Hash the entire path so both runtime identity and socket purpose stay distinct.
  // Broker services create this private directory (0700) and socket (0600).
  const identity = crypto.createHash("sha256").update(resolved).digest("hex");
  return `/tmp/mapache-ipc-${identity}/agent.sock`;
}

module.exports = {boundedUnixSocketPath};

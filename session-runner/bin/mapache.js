#!/usr/bin/env node
"use strict";

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[0] !== "files" || args[1] !== "pull") {
    throw new Error("Usage: mapache files pull <path>\nFetch a large-file pointer after checking memory headroom and verifying its checksum.");
  }
  require("../lib/runnerEnvironment").isolateRunnerGoogleCredentials();
  const {createConfig} = require("../lib/config");
  const {db, storage} = require("../lib/services");
  const {pullLargeFile} = require("../lib/workspaceLargeFilePull");
  const result = await pullLargeFile({config: createConfig(), db, storage, requestedPath: args[2]});
  console.log(`Fetched ${result.path} (${result.byteLength} bytes; SHA-256 verified)`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

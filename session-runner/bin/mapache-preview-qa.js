#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const {createBrowserQaService} = require("../lib/browserQa");
const {createConfig} = require("../lib/config");

async function main(argv) {
  const {outputDir, specPath} = parseArgs(argv);
  const config = createConfig();
  const browserQa = createBrowserQaService(config);
  const spec = specPath ? JSON.parse(fs.readFileSync(path.resolve(specPath), "utf8")) : {};
  const result = await browserQa.run(spec, {outputDir});
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseArgs(argv) {
  let outputDir = "";
  let specPath = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output") {
      outputDir = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--spec") {
      specPath = argv[index + 1] || "";
      index += 1;
    }
  }
  return {outputDir, specPath};
}

main(process.argv.slice(2)).catch((error) => {
  if (error && error.result) {
    process.stderr.write(`${JSON.stringify(error.result, null, 2)}\n`);
  } else {
    process.stderr.write(`${error && error.stack || error}\n`);
  }
  process.exit(1);
});

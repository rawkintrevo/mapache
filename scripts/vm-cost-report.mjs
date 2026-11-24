#!/usr/bin/env node
import {readFile, writeFile} from "node:fs/promises";
import {buildVmCostReport, PROJECT_ID} from "./lib/vm-cost-model.mjs";

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const match = argument.match(/^--([^=]+)(?:=(.*))?$/);
    if (!match || !["project", "input", "output"].includes(match[1])) throw new Error("usage: --project=pi-agents-cloud --input=worksheet.json [--output=report.json]");
    const value = match[2] ?? argv[++index];
    if (!value || options[match[1]]) throw new Error("usage: --project=pi-agents-cloud --input=worksheet.json [--output=report.json]");
    options[match[1]] = value;
  }
  if (options.project !== PROJECT_ID) throw new Error("explicit_project_required");
  if (!options.input) throw new Error("cost_input_required");
  return options;
}

export async function run(argv = process.argv.slice(2), {stdout = process.stdout} = {}) {
  const options = parseArgs(argv);
  const input = JSON.parse(await readFile(options.input, "utf8"));
  const report = buildVmCostReport(input);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    await writeFile(options.output, serialized, {encoding: "utf8", flag: "wx", mode: 0o600});
  } else {
    stdout.write(serialized);
  }
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(error => {
    console.error(`VM cost report failed: ${error.code || error.message}`);
    process.exitCode = 1;
  });
}

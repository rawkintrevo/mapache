import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "functions", "runnerCatalog.json");
const outputPath = path.join(root, "session-runner", "lib", "harnesses", "generatedCatalog.json");

function generatedCatalog() {
  const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  return {
    harnesses: source.harnesses,
    images: source.images,
  };
}

function renderedCatalog() {
  return `${JSON.stringify(generatedCatalog(), null, 2)}\n`;
}

function checkCatalog() {
  const expected = renderedCatalog();
  const actual = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
  if (actual !== expected) {
    throw new Error("session-runner/lib/harnesses/generatedCatalog.json is stale; run npm run generate:runner-catalog");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--check")) {
    checkCatalog();
    console.log("Generated runner catalog is current.");
  } else {
    fs.writeFileSync(outputPath, renderedCatalog());
    console.log(`Generated ${path.relative(root, outputPath)} from ${path.relative(root, sourcePath)}.`);
  }
}

export {checkCatalog, generatedCatalog, outputPath, renderedCatalog, sourcePath};

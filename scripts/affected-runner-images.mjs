const STANDARD_VARIANTS = Object.freeze([
  "default",
  "pi-basic",
  "pi-web",
  "pi-chrome",
  "codex-basic",
  "codex-web",
  "codex-chrome",
]);

const ALL_VARIANTS = Object.freeze([...STANDARD_VARIANTS, "pi-n64"]);

function normalizeFiles(files) {
  return [...new Set((files || []).map((file) => String(file).trim()).filter(Boolean))];
}

function imageVariantForFile(file) {
  const match = file.match(/(?:Dockerfile|cloudbuild)\.(pi-basic|pi-web|pi-chrome|pi-n64|codex-basic|codex-web|codex-chrome)(?:\.yaml)?$/);
  if (match) return match[1];
  if (file === "session-runner/Dockerfile" || file === "session-runner/cloudbuild.yaml") return "default";
  return null;
}

function affectedRunnerVariants(files, options = {}) {
  const changed = normalizeFiles(files);
  const explicit = normalizeFiles(options.variants).filter((variant) => ALL_VARIANTS.includes(variant));
  const affected = new Set(explicit);
  const runnerFiles = changed.filter((file) => file.startsWith("session-runner/"));
  const catalogChanged = changed.some((file) => file === "functions/runnerCatalog.json" || file === "functions/runnerCatalog.helpers.js");

  if (catalogChanged) STANDARD_VARIANTS.forEach((variant) => affected.add(variant));
  for (const file of runnerFiles) {
    const directVariant = imageVariantForFile(file);
    if (directVariant) affected.add(directVariant);
    else if (!file.includes("n64")) STANDARD_VARIANTS.forEach((variant) => affected.add(variant));
  }

  const n64Requested = Boolean(options.includeN64) || explicit.includes("pi-n64") || changed.some((file) => file.includes("n64"));
  if (n64Requested && runnerFiles.length) affected.add("pi-n64");
  if (!n64Requested) affected.delete("pi-n64");
  return ALL_VARIANTS.filter((variant) => affected.has(variant));
}

function parseArgs(argv) {
  const values = new Map();
  for (const arg of argv) {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    values.set(key, rest.join("="));
  }
  return values;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const files = (args.get("files") || "").split(",");
  const variants = affectedRunnerVariants(files, {
    includeN64: args.get("include-n64") === "true",
    variants: (args.get("variants") || "").split(","),
  });
  console.log(JSON.stringify(variants));
}

export {ALL_VARIANTS, STANDARD_VARIANTS, affectedRunnerVariants, imageVariantForFile};

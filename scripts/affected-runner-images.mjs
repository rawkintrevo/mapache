const SUPPORTED_VARIANT = "pi-chrome";
const STANDARD_VARIANTS = Object.freeze([SUPPORTED_VARIANT]);
const ALL_VARIANTS = STANDARD_VARIANTS;

function normalizeFiles(files) {
  return [...new Set((files || []).map((file) => String(file).trim()).filter(Boolean))];
}

function imageVariantForFile(file) {
  const match = file.match(/(?:Dockerfile|cloudbuild)\.(pi-chrome)(?:\.yaml)?$/);
  if (match) return match[1];
  return null;
}

function affectedRunnerVariants(files, options = {}) {
  const changed = normalizeFiles(files);
  const explicit = normalizeFiles(options.variants).filter((variant) => ALL_VARIANTS.includes(variant));
  const affected = new Set(explicit);
  const runnerFiles = changed.filter((file) => file.startsWith("session-runner/"));
  const catalogChanged = changed.some((file) => file === "functions/runnerCatalog.json" || file === "functions/runnerCatalog.helpers.js");

  if (catalogChanged) affected.add(SUPPORTED_VARIANT);
  for (const file of runnerFiles) {
    const directVariant = imageVariantForFile(file);
    if (directVariant) affected.add(directVariant);
    else affected.add(SUPPORTED_VARIANT);
  }
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
    variants: (args.get("variants") || "").split(","),
  });
  console.log(JSON.stringify(variants));
}

export {ALL_VARIANTS, STANDARD_VARIANTS, SUPPORTED_VARIANT, affectedRunnerVariants, imageVariantForFile};

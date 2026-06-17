import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const roots = ["AGENTS.md", "docs", "adrs"];
const ignoredSchemes = /^(?:https?:|mailto:|tel:|data:|javascript:)/i;
const markdownLinkPattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

function collectFiles(target) {
  const fullPath = path.join(repoRoot, target);
  if (!fs.existsSync(fullPath)) {
    return [];
  }
  const stat = fs.statSync(fullPath);
  if (stat.isFile()) {
    return [fullPath];
  }
  return fs.readdirSync(fullPath, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(fullPath, entry.name);
    if (entry.isDirectory()) {
      return collectFiles(path.relative(repoRoot, entryPath));
    }
    return entry.isFile() && /\.(?:md|mdx)$/i.test(entry.name) ? [entryPath] : [];
  });
}

function stripAnchorAndQuery(href) {
  return href.split("#")[0].split("?")[0];
}

function resolveTarget(sourceFile, href) {
  const cleanHref = decodeURIComponent(stripAnchorAndQuery(href));
  if (!cleanHref || ignoredSchemes.test(cleanHref) || cleanHref.startsWith("#")) {
    return null;
  }
  if (path.isAbsolute(cleanHref)) {
    return path.join(repoRoot, cleanHref);
  }
  return path.resolve(path.dirname(sourceFile), cleanHref);
}

const files = roots.flatMap(collectFiles);
const failures = [];

for (const file of files) {
  const relativeFile = path.relative(repoRoot, file);
  const text = fs.readFileSync(file, "utf8");
  for (const match of text.matchAll(markdownLinkPattern)) {
    const href = match[1].trim();
    const target = resolveTarget(file, href);
    if (!target) {
      continue;
    }
    if (!fs.existsSync(target)) {
      failures.push(`${relativeFile}: missing link target ${href}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Broken documentation links:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`Checked ${files.length} documentation files. No broken relative links found.`);

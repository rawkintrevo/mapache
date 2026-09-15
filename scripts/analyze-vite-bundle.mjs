import {readFile, readdir} from "node:fs/promises";
import {gzipSync} from "node:zlib";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const indexHtml = await readFile(path.join(distDir, "index.html"), "utf8");
const entryMatch = indexHtml.match(/<script[^>]+src="([^"]+\.js)"/);

if (!entryMatch) throw new Error("Could not find the Vite entry script in dist/index.html.");

const entryPath = path.join(distDir, entryMatch[1].replace(/^\//, ""));
const sourceMapPath = `${entryPath}.map`;
const [entryBuffer, sourceMapText] = await Promise.all([
  readFile(entryPath),
  readFile(sourceMapPath, "utf8").catch(() => {
    throw new Error("Source map not found. Run `vite build --sourcemap` before analyzing the bundle.");
  }),
]);
const sourceMap = JSON.parse(sourceMapText);
const generatedLines = entryBuffer.toString("utf8").split("\n");
const initialAssetPaths = new Set(
  [...indexHtml.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)]
    .map((match) => path.join(distDir, match[1].replace(/^\//, ""))),
);
const emittedAssetPaths = (await readdir(path.join(distDir, "assets")))
  .filter((name) => /\.(?:js|css)$/.test(name))
  .map((name) => path.join(distDir, "assets", name));
const assetSizes = await Promise.all(emittedAssetPaths.map(readAssetSize));
const initialAssets = assetSizes.filter((asset) => initialAssetPaths.has(path.join(root, asset.name)));
const lazyAssets = assetSizes.filter((asset) => !initialAssetPaths.has(path.join(root, asset.name)));
const sourceBytes = attributeGeneratedCharacters(sourceMap, generatedLines);
const packageBytes = new Map();

for (const [source, bytes] of sourceBytes) {
  const packageName = packageForSource(source);
  packageBytes.set(packageName, (packageBytes.get(packageName) || 0) + bytes);
}

const attributedBytes = [...sourceBytes.values()].reduce((total, bytes) => total + bytes, 0);
const report = {
  entry: path.relative(root, entryPath),
  minifiedBytes: entryBuffer.byteLength,
  gzipBytes: gzipSync(entryBuffer, {level: 9}).byteLength,
  attributedBytes,
  attributedPercent: Number((attributedBytes / entryBuffer.byteLength * 100).toFixed(1)),
  initialAssets,
  initialGzipBytes: initialAssets.reduce((total, asset) => total + asset.gzipBytes, 0),
  lazyAssets,
  largestPackages: sortedEntries(packageBytes).slice(0, 15).map(([name, bytes]) => ({name, bytes})),
  largestSources: sortedEntries(sourceBytes).slice(0, 25).map(([name, bytes]) => ({name, bytes})),
};

console.log(JSON.stringify(report, null, 2));

async function readAssetSize(assetPath) {
  const contents = await readFile(assetPath);
  return {
    name: path.relative(root, assetPath),
    minifiedBytes: contents.byteLength,
    gzipBytes: gzipSync(contents, {level: 9}).byteLength,
  };
}

function attributeGeneratedCharacters(map, generated) {
  const base64Values = new Map(
    [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].map((character, index) => [character, index]),
  );
  const totals = new Map();
  let previousSource = 0;
  let previousSourceLine = 0;
  let previousSourceColumn = 0;
  let previousName = 0;

  for (const [lineIndex, mappingLine] of map.mappings.split(";").entries()) {
    let generatedColumn = 0;
    const segments = [];

    for (const rawSegment of mappingLine.split(",")) {
      if (!rawSegment) continue;
      const fields = decodeVlq(rawSegment, base64Values);
      generatedColumn += fields[0];
      let sourceIndex = null;
      if (fields.length >= 4) {
        previousSource += fields[1];
        previousSourceLine += fields[2];
        previousSourceColumn += fields[3];
        sourceIndex = previousSource;
        if (fields.length >= 5) previousName += fields[4];
      }
      segments.push({generatedColumn, sourceIndex});
    }

    const lineLength = generated[lineIndex]?.length || 0;
    for (const [segmentIndex, segment] of segments.entries()) {
      if (segment.sourceIndex === null) continue;
      const nextColumn = segments[segmentIndex + 1]?.generatedColumn ?? lineLength;
      const bytes = Math.max(0, nextColumn - segment.generatedColumn);
      const source = map.sources[segment.sourceIndex] || "(unknown)";
      totals.set(source, (totals.get(source) || 0) + bytes);
    }
  }
  return totals;
}

function decodeVlq(segment, base64Values) {
  const fields = [];
  let value = 0;
  let shift = 0;

  for (const character of segment) {
    const digit = base64Values.get(character);
    if (digit === undefined) throw new Error(`Invalid source-map VLQ character: ${character}`);
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    fields.push((value >> 1) * (value & 1 ? -1 : 1));
    value = 0;
    shift = 0;
  }
  return fields;
}

function packageForSource(source) {
  const match = source.match(/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(@[^/]+\/[^/]+|[^/]+)/);
  if (match) return match[1];
  if (source.includes("/src/")) return "application source";
  return "other";
}

function sortedEntries(values) {
  return [...values.entries()].sort((left, right) => right[1] - left[1]);
}

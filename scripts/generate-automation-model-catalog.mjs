// Export only picker labels/IDs from the same Pi AI version as the runner SDK.
import {execFileSync} from "node:child_process";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(join(root, "session-runner/upstream/pi-web-ui/manifest.json"), "utf8"));
const directory = await mkdtemp(join(tmpdir(), "mapache-model-catalog-"));
try {
  const [packed] = JSON.parse(execFileSync("npm", ["pack", `@earendil-works/pi-ai@${manifest.piSdk.version}`, "--ignore-scripts", "--json", "--pack-destination", directory], {encoding: "utf8"}));
  execFileSync("tar", ["-xzf", join(directory, packed.filename), "-C", directory]);
  const {MODELS} = await import(pathToFileURL(join(directory, "package/dist/models.generated.js")));
  const providers = Object.fromEntries(Object.entries(MODELS).sort(([a], [b]) => a.localeCompare(b, "en")).map(([provider, models]) => [
    provider,
    Object.fromEntries(Object.values(models).sort((a, b) => a.id.localeCompare(b.id, "en")).map(({id, name}) => [id, name])),
  ]));
  await writeFile(join(root, "src/config/automationModelCatalog.json"), `${JSON.stringify({source: {package: packed.name, version: packed.version, integrity: packed.integrity}, providers}, null, 2)}\n`);
  console.log(`Generated automation picker catalog from ${packed.id} (${Object.keys(providers).length} providers).`);
} finally {
  await rm(directory, {recursive: true, force: true});
}

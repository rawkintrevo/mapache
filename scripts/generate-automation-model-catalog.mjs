// Export only picker labels/IDs from the Pi AI package itself. The checked-in
// file is an offline fallback; the live runner owns capability validation and
// may resolve a different SDK and pi-ai version at image-build time.
import {execFileSync} from "node:child_process";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "mapache-model-catalog-"));
try {
  const packageSpec = process.env.PI_AI_CATALOG_SPEC || "@earendil-works/pi-ai@latest";
  const [packed] = JSON.parse(execFileSync("npm", ["pack", packageSpec, "--ignore-scripts", "--json", "--pack-destination", directory], {encoding: "utf8"}));
  execFileSync("tar", ["-xzf", join(directory, packed.filename), "-C", directory]);
  const {MODELS} = await import(pathToFileURL(join(directory, "package/dist/models.generated.js")));
  const providers = Object.fromEntries(Object.entries(MODELS).sort(([a], [b]) => a.localeCompare(b, "en")).map(([provider, models]) => [
    provider,
    Object.fromEntries(Object.values(models).sort((a, b) => a.id.localeCompare(b.id, "en")).map(({id, name}) => [id, name])),
  ]));
  const modelOverrides = {"openai-codex": {"gpt-6-astra": "GPT-6 Astra"}};
  for (const [provider, models] of Object.entries(modelOverrides)) {
    providers[provider] ||= {};
    for (const [id, name] of Object.entries(models)) providers[provider][id] ||= name;
  }
  await writeFile(join(root, "src/config/automationModelCatalog.json"), `${JSON.stringify({source: {package: packed.name, version: packed.version, integrity: packed.integrity, modelOverrides: ["openai-codex/gpt-6-astra"]}, providers}, null, 2)}\n`);
  console.log(`Generated automation picker catalog from ${packed.id} (${Object.keys(providers).length} providers).`);
} finally {
  await rm(directory, {recursive: true, force: true});
}

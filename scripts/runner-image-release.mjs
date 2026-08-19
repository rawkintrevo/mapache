function normalizeSha(sourceSha) {
  const sha = String(sourceSha || "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("runner image source revision must be a 40-character commit SHA");
  return sha;
}

function immutableRunnerTag(variant, sourceSha) {
  const cleanVariant = String(variant || "").trim();
  if (!cleanVariant) throw new Error("runner image variant is required");
  return `${cleanVariant}-${normalizeSha(sourceSha)}`;
}

function pullRequestRunnerTag(variant, pullRequestNumber, sourceSha) {
  const number = String(pullRequestNumber || "").trim();
  if (!/^\d+$/.test(number)) throw new Error("pull request number is required for preview runner tags");
  return `${variant}-pr-${number}-${normalizeSha(sourceSha).slice(0, 12)}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = new Map(process.argv.slice(2).map((arg) => {
    const [key, ...value] = arg.replace(/^--/, "").split("=");
    return [key, value.join("=")];
  }));
  const tag = args.get("pr") ?
    pullRequestRunnerTag(args.get("variant"), args.get("pr"), args.get("sha")) :
    immutableRunnerTag(args.get("variant"), args.get("sha"));
  console.log(tag);
}

export {immutableRunnerTag, normalizeSha, pullRequestRunnerTag};

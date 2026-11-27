export function deriveRunnerHealthUrl(agentUrl) {
  try {
    const url = new URL(agentUrl);
    url.pathname = url.pathname.replace(/agent\/?$/, "runner/health");
    return url.toString();
  } catch {
    return "";
  }
}

export async function readRunnerHealth(url, fetchImpl = globalThis.fetch) {
  if (!url || typeof fetchImpl !== "function") return false;
  try {
    const response = await fetchImpl(url, {cache: "no-store", credentials: "include"});
    if (!response.ok) return false;
    const health = await response.json();
    return health?.ok === true && health?.agentRuntime?.ready === true;
  } catch {
    return false;
  }
}

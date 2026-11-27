import { readFileSync } from "node:fs";
import { join } from "node:path";

export const isMapacheCustomProvider = (id: string): boolean => /^custom-[a-z0-9][a-z0-9-]{0,62}$/.test(id);

function endpoint(value: unknown): string {
  const url = new URL(String(value || ""));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid custom provider endpoint");
  }
  return url.href.replace(/\/+$/, "");
}

/** Credentials are resolved only by provider ID and the endpoint saved in Mapache. */
export function mapacheProviderKey(agentDir: string, id: string, baseUrl: string, api?: string): string {
  if (!isMapacheCustomProvider(id) || api !== "openai-completions") {
    throw new Error("Select an OpenAI-compatible connection saved in Mapache");
  }
  let credential: {key?: string; mapacheBaseUrl?: string} | undefined;
  try {
    credential = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"))[id];
  } catch { /* Missing auth is reported without exposing file contents. */ }
  if (!credential?.key || !credential.mapacheBaseUrl) {
    throw new Error("Select this connection in Mapache Authentication and restart the workspace");
  }
  if (endpoint(baseUrl) !== endpoint(credential.mapacheBaseUrl)) {
    throw new Error("Endpoint differs from this connection in Mapache Authentication. Update the connection there first");
  }
  return credential.key;
}

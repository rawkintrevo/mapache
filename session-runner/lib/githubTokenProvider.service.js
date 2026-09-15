"use strict";

const MAX_RESPONSE_BYTES = 16 * 1024;
const REFRESH_SAFETY_WINDOW_MS = 5 * 60 * 1000;

function createGithubTokenProvider({config, fetchImpl = globalThis.fetch, now = () => Date.now(), safetyWindowMs = REFRESH_SAFETY_WINDOW_MS, timeoutMs = 10000} = {}) {
  let cached = normalizeToken(config?.githubAutomationToken, config?.githubAutomationTokenExpiresAt);
  let inFlight = null;

  async function getToken({forceRefresh = false} = {}) {
    if (!forceRefresh && cached && cached.expiresAt - now() > safetyWindowMs) return cached.token;
    if (!config?.githubAutomationTokenRefreshUrl) throw new Error("github_token_refresh_unconfigured");
    if (!inFlight) inFlight = refresh().finally(() => { inFlight = null; });
    cached = await inFlight;
    return cached.token;
  }

  async function refresh() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(config.githubAutomationTokenRefreshUrl, {
        method: "POST", signal: controller.signal,
        headers: {"content-type": "application/json", "x-shutdown-token": config.shutdownToken},
        body: JSON.stringify({workspaceId: config.workspaceId, sessionId: config.sessionId}),
      });
      const length = Number(response.headers?.get?.("content-length") || 0);
      if (length > MAX_RESPONSE_BYTES) throw new Error("github_token_refresh_response_too_large");
      const body = await response.text();
      if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) throw new Error("github_token_refresh_response_too_large");
      let data;
      try { data = JSON.parse(body); } catch (error) { throw new Error("github_token_refresh_malformed_response"); }
      if (!response.ok) throw new Error(`github_token_refresh_failed:${response.status}:${String(data.error || "request_failed")}`);
      const result = normalizeToken(data.accessToken, data.expiresAt);
      if (!result) throw new Error("github_token_refresh_invalid_response");
      return result;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("github_token_refresh_timeout");
      throw error;
    } finally { clearTimeout(timer); }
  }

  async function withToken(task) { return task(await getToken()); }
  async function withRetry(task) {
    try { return await task(await getToken()); } catch (error) {
      if (Number(error?.status) !== 401 && !/\b401\b/.test(String(error?.message || ""))) throw error;
      cached = null;
      return task(await getToken({forceRefresh: true}));
    }
  }
  return {getToken, withToken, withRetry, invalidate: () => { cached = null; }};
}

function normalizeToken(token, expiresAt) {
  const value = String(token || "").trim();
  const expiry = Date.parse(String(expiresAt || ""));
  return value && Number.isFinite(expiry) ? {token: value, expiresAt: expiry} : null;
}

module.exports = {createGithubTokenProvider, normalizeToken, REFRESH_SAFETY_WINDOW_MS};

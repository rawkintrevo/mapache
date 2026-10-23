"use strict";

const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const {ensurePrivateRuntimeDirectory} = require("./runtimeStorage.helpers");
const {createGithubTokenProvider} = require("./githubTokenProvider.service");

// Only the runner holds the broker credential; clients cannot select a session
// or repository. The existing broker validates the runner's source binding.
function createGithubTokenApiService(config, {fetchImpl} = {}) {
  const socketPath = config.githubTokenSocketPath;
  const provider = createGithubTokenProvider({config, fetchImpl});
  let server;
  async function start() {
    if (!socketPath || !config.githubAutomationTokenRefreshUrl || !config.shutdownToken || server) return;
    await ensurePrivateRuntimeDirectory(path.dirname(socketPath));
    await fs.unlink(socketPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
    server = http.createServer(async (request, response) => {
      response.setHeader("cache-control", "no-store");
      response.setHeader("content-type", "application/json");
      request.resume();
      if (request.method !== "POST" || request.url !== "/github/token") {
        response.writeHead(404).end(JSON.stringify({error: "not_found"}));
        return;
      }
      try {
        response.end(JSON.stringify({accessToken: await provider.getToken()}));
      } catch {
        response.writeHead(502).end(JSON.stringify({error: "github_token_refresh_failed"}));
      }
    });
    server.requestTimeout = 15000;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await fs.chmod(socketPath, 0o600);
  }
  async function stop() {
    if (!server) return;
    const current = server;
    server = null;
    await new Promise((resolve) => current.close(resolve));
    await fs.unlink(socketPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
  return {start, stop};
}

function getGithubSocketToken(socketPath) {
  return new Promise((resolve, reject) => {
    const request = http.request({socketPath, path: "/github/token", method: "POST"}, (response) => {
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
        if (Buffer.byteLength(body) > 16 * 1024) request.destroy(new Error("github_token_response_too_large"));
      });
      response.on("error", reject);
      response.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (response.statusCode !== 200 || typeof data.accessToken !== "string" || !data.accessToken || /[\r\n]/.test(data.accessToken)) {
            throw new Error("github_token_refresh_failed");
          }
          resolve(data.accessToken);
        } catch { reject(new Error("github_token_refresh_failed")); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error("github_token_refresh_timeout")), 15000);
    request.on("close", () => clearTimeout(timer));
    request.on("error", reject);
    request.end();
  });
}

module.exports = {createGithubTokenApiService, getGithubSocketToken};

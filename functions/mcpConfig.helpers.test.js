"use strict";

const assert = require("assert");
const {
  mcpConfigForRunner,
  normalizeMcpConfigPayload,
} = require("./mcpConfig.helpers");

assert.deepStrictEqual(normalizeMcpConfigPayload({
  servers: [{
    name: "chrome-devtools",
    command: "npx",
    args: ["-y", "chrome-devtools-mcp@latest"],
    env: {CHROME_PROFILE: "qa"},
    lifecycle: "lazy",
  }],
}), {
  version: 1,
  mcpServers: {
    "chrome-devtools": {
      command: "npx",
      args: ["-y", "chrome-devtools-mcp@latest"],
      env: {CHROME_PROFILE: "qa"},
      lifecycle: "lazy",
    },
  },
});

assert.deepStrictEqual(normalizeMcpConfigPayload({
  mcpServers: {
    gmail: {
      url: "https://gmailmcp.googleapis.com/mcp/v1",
      authMode: "oauth2",
      oauthClientRef: "google-client-prod",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      secretRefs: {refreshToken: "GOOGLE_REFRESH_TOKEN"},
      oauthRedirectUri: "https://mapache.example.com/api/google/callback",
    },
  },
}), {
  version: 1,
  mcpServers: {
    gmail: {
      url: "https://gmailmcp.googleapis.com/mcp/v1",
      authMode: "oauth2",
      oauthClientRef: "google-client-prod",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      secretRefs: {refreshToken: "GOOGLE_REFRESH_TOKEN"},
      oauthRedirectUri: "https://mapache.example.com/api/google/callback",
    },
  },
});
assert.deepStrictEqual(normalizeMcpConfigPayload({
  mcpServers: {
    drive: {
      url: "https://drivemcp.googleapis.com/mcp/v1",
      authMode: "bearer_env",
      bearerTokenEnv: "GOOGLE_BEARER_TOKEN",
    },
  },
}), {
  version: 1,
  mcpServers: {
    drive: {
      url: "https://drivemcp.googleapis.com/mcp/v1",
      authMode: "bearer_env",
      bearerTokenEnv: "GOOGLE_BEARER_TOKEN",
    },
  },
});

assert.deepStrictEqual(normalizeMcpConfigPayload({
  mcpServers: {
    context7: {
      url: "https://mcp.context7.com/mcp",
      headers: {AUTHORIZATION: "Bearer CONTEXT7_TOKEN"},
    },
  },
}), {
  version: 1,
  mcpServers: {
    context7: {
      url: "https://mcp.context7.com/mcp",
      headers: {AUTHORIZATION: "Bearer CONTEXT7_TOKEN"},
    },
  },
});

assert.throws(() => normalizeMcpConfigPayload({servers: [{name: "Bad Name", command: "npx"}]}), /invalid_mcp_server_name/);
assert.throws(() => normalizeMcpConfigPayload({servers: [{name: "x"}]}), /missing_mcp_server_transport/);
assert.throws(() => normalizeMcpConfigPayload({servers: [{name: "x", command: "npx", url: "http://localhost"}]}), /multiple_mcp_server_transports/);
assert.throws(() => normalizeMcpConfigPayload({servers: [{name: "x", url: "https://example.com", authMode: "oauth2", oauthClientRef: "client", scopes: [], clientSecret: "secret"}]}), /literal_mcp_credential_not_allowed/);
assert.throws(() => normalizeMcpConfigPayload({servers: [{name: "x", url: "https://example.com", authMode: "oauth2", oauthClientRef: "client", scopes: ["not-a-scope"]}]}), /invalid_mcp_scopes/);
assert.throws(() => normalizeMcpConfigPayload({servers: [{name: "x", url: "https://example.com", authMode: "bearer_env", bearerTokenEnv: "literal-token"}]}), /invalid_mcp_bearer_token_env/);
assert.deepStrictEqual(mcpConfigForRunner({mcpConfig: {mcpServers: {demo: {command: "node"}}}}), {
  version: 1,
  mcpServers: {demo: {command: "node", args: []}},
});

console.log("mcp config helper tests passed");

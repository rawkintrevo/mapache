"use strict";

const crypto = require("crypto");
const logger = require("firebase-functions/logger");
const {
  GITHUB_APP_CLIENT_ID_SECRET,
  GITHUB_APP_CLIENT_SECRET_SECRET,
  GITHUB_APP_ID_SECRET,
  GITHUB_APP_PRIVATE_KEY_SECRET,
} = require("./backendConfig");
const {httpError} = require("./backendUtils.helpers");

function createGithubClientService(dependencies = {}) {
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const now = typeof dependencies.now === "function" ? dependencies.now : () => Date.now();
  const readSecret = typeof dependencies.readSecret === "function" ? dependencies.readSecret : defaultSecretReader;

  function readConfigValue(secret, environmentName) {
    return secretValue(secret, readSecret) || process.env[environmentName] || "";
  }

  function appId() {
    return readConfigValue(GITHUB_APP_ID_SECRET, "GITHUB_APP_ID");
  }

  function clientId() {
    return readConfigValue(GITHUB_APP_CLIENT_ID_SECRET, "GITHUB_APP_CLIENT_ID");
  }

  function clientSecret() {
    return readConfigValue(GITHUB_APP_CLIENT_SECRET_SECRET, "GITHUB_APP_CLIENT_SECRET");
  }

  function privateKey() {
    return readConfigValue(GITHUB_APP_PRIVATE_KEY_SECRET, "GITHUB_APP_PRIVATE_KEY");
  }

  async function requestJson(url, token, options = {}) {
    return requestGithubJson(fetchImpl, url, token, options);
  }

  return Object.freeze({
    createGithubAppJwt: () => createGithubAppJwt(appId, privateKey, now),
    createGithubInstallationToken: (installationId) =>
      createGithubInstallationToken(installationId, appId, privateKey, now, fetchImpl),
    createGithubPullRequest: (payload) => createGithubPullRequest(fetchImpl, payload),
    exchangeGithubOAuthCode: (code, redirectUri) =>
      exchangeGithubOAuthCode(fetchImpl, clientId, clientSecret, code, redirectUri),
    getGithubOAuthClientId: () => cleanGithubValue(clientId()),
    getGithubPullRequestTemplate: (owner, repo, baseBranch, token) =>
      getGithubPullRequestTemplate(requestJson, owner, repo, baseBranch, token),
    getGithubRepository: (owner, repo, token) => getGithubRepository(requestJson, owner, repo, token),
    isGithubAppConfigured: () => Boolean(normalizeGithubAppId(appId()) && normalizeGithubPrivateKey(privateKey())),
    isGithubOAuthConfigured: () => Boolean(clientId() && clientSecret()),
    listGithubInstallationRepositories: (installationId, token) =>
      listGithubInstallationRepositories(fetchImpl, installationId, token),
    listGithubUserInstallations: (token) => listGithubUserInstallations(requestJson, token),
    requestGithubJson: requestJson,
  });
}

async function exchangeGithubOAuthCode(fetchImpl, clientId, clientSecret, code, redirectUri) {
  let response;
  try {
    response = await fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        "user-agent": "mapahce-functions",
      },
      body: JSON.stringify({
        client_id: clientId(),
        client_secret: clientSecret(),
        code,
        redirect_uri: redirectUri,
      }),
    });
  } catch (error) {
    throw httpError(502, "github_oauth_token_failed", error);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    logger.error("github oauth token exchange failed", {
      status: response.status,
      error: cleanGithubValue(data.error),
      errorDescription: cleanGithubValue(data.error_description),
    });
    throw httpError(502, "github_oauth_token_failed");
  }
  return data;
}

async function listGithubUserInstallations(requestJson, token) {
  const installations = [];
  for (let page = 1; page <= 20; page += 1) {
    const url = new URL("https://api.github.com/user/installations");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const data = await requestJson(url.toString(), token, {
      failureError: "github_user_installations_failed",
    });
    const pageInstallations = Array.isArray(data && data.installations) ? data.installations : [];
    installations.push(...pageInstallations);
    if (pageInstallations.length < 100) {
      break;
    }
  }
  return installations;
}

async function listGithubInstallationRepositories(fetchImpl, installationId, token) {
  const repositories = [];
  for (let page = 1; page <= 20; page += 1) {
    const url = new URL("https://api.github.com/installation/repositories");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));

    let response;
    try {
      response = await fetchImpl(url, {
        headers: {
          "accept": "application/vnd.github+json",
          "authorization": `Bearer ${token}`,
          "user-agent": "mapahce-functions",
          "x-github-api-version": "2022-11-28",
        },
      });
    } catch (error) {
      throw httpError(502, "github_connected_repos_failed", error);
    }

    if (response.status === 404) {
      throw httpError(404, "github_installation_not_found");
    }

    if (!response.ok) {
      const errorBody = await safeReadGithubErrorBody(response);
      logger.error("github installation repository list failed", {
        installationId,
        status: response.status,
        body: errorBody,
      });
      throw httpError(502, "github_connected_repos_failed");
    }

    let data;
    try {
      data = await response.json();
    } catch (error) {
      throw httpError(502, "github_connected_repos_failed", error);
    }

    const pageRepos = Array.isArray(data && data.repositories) ? data.repositories : null;
    if (!pageRepos) {
      throw httpError(502, "github_connected_repos_failed");
    }

    repositories.push(...pageRepos);
    if (pageRepos.length < 100) {
      break;
    }
  }

  return repositories;
}

async function createGithubInstallationToken(installationId, appId, privateKey, now, fetchImpl) {
  if (!normalizeGithubAppId(appId()) || !normalizeGithubPrivateKey(privateKey())) {
    throw httpError(503, "github_app_not_configured");
  }

  const normalizedInstallationId = normalizeGithubInstallationId(installationId);
  const appJwt = createGithubAppJwt(appId, privateKey, now);
  const response = await requestGithubInstallationToken(fetchImpl, normalizedInstallationId, appJwt);

  return {
    installationId: normalizedInstallationId,
    token: cleanGithubToken(response.token),
    expiresAt: cleanGithubTimestamp(response.expires_at),
    permissions: normalizeGithubTokenPermissions(response.permissions),
    repositorySelection: cleanGithubValue(response.repository_selection),
  };
}

function isGithubAppConfigured(appId, privateKey) {
  return Boolean(normalizeGithubAppId(appId()) && normalizeGithubPrivateKey(privateKey()));
}

function normalizeGithubInstallationId(value) {
  const installationId = String(value || "").trim();
  if (!/^\d+$/.test(installationId)) {
    throw httpError(400, "invalid_github_installation_id");
  }
  return installationId;
}

function normalizeGithubAppId(value) {
  return String(value || "").trim();
}

function normalizeGithubPrivateKey(value) {
  const key = String(value || "").trim();
  return key ? key.replace(/\\n/g, "\n") : "";
}

function createGithubAppJwt(appId, privateKey, now) {
  const normalizedAppId = normalizeGithubAppId(appId());
  const normalizedPrivateKey = normalizeGithubPrivateKey(privateKey());
  if (!normalizedAppId || !normalizedPrivateKey) {
    throw httpError(503, "github_app_not_configured");
  }

  const issuedAt = Math.floor(now() / 1000) - 60;
  const expiresAt = issuedAt + (9 * 60);
  const header = {alg: "RS256", typ: "JWT"};
  const payload = {
    iat: issuedAt,
    exp: expiresAt,
    iss: normalizedAppId,
  };
  const encodedHeader = encodeJwtSegment(header);
  const encodedPayload = encodeJwtSegment(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  try {
    const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), normalizedPrivateKey)
        .toString("base64url");
    return `${signingInput}.${signature}`;
  } catch (error) {
    throw httpError(502, "github_app_jwt_failed", error);
  }
}

async function requestGithubInstallationToken(fetchImpl, installationId, appJwt) {
  let response;
  try {
    response = await fetchImpl(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        "accept": "application/vnd.github+json",
        "authorization": `Bearer ${appJwt}`,
        "user-agent": "mapahce-functions",
        "x-github-api-version": "2022-11-28",
      },
    });
  } catch (error) {
    throw httpError(502, "github_installation_token_failed", error);
  }

  if (response.status === 404) {
    throw httpError(404, "github_installation_not_found");
  }

  if (!response.ok) {
    const errorBody = await safeReadGithubErrorBody(response);
    logger.error("github installation token request failed", {
      installationId,
      status: response.status,
      body: errorBody,
    });
    throw httpError(502, "github_installation_token_failed");
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw httpError(502, "github_installation_token_failed", error);
  }

  if (!data || typeof data.token !== "string" || !data.token.trim()) {
    throw httpError(502, "github_installation_token_failed");
  }

  return data;
}

async function getGithubRepository(requestJson, owner, repo, token) {
  return requestJson(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, token, {
    failureError: "github_repository_lookup_failed",
  });
}

async function getGithubPullRequestTemplate(requestJson, owner, repo, baseBranch, token) {
  const directPaths = [
    ".github/pull_request_template.md",
    ".github/pull_request_template.txt",
    "docs/pull_request_template.md",
    "docs/pull_request_template.txt",
    "pull_request_template.md",
    "pull_request_template.txt",
  ];
  for (const templatePath of directPaths) {
    const content = await getGithubRepositoryFile(requestJson, owner, repo, templatePath, baseBranch, token);
    if (content) {
      return {body: content, source: `repository_template:${templatePath}`};
    }
  }

  const templateDirs = [
    ".github/PULL_REQUEST_TEMPLATE",
    "docs/PULL_REQUEST_TEMPLATE",
    "PULL_REQUEST_TEMPLATE",
  ];
  for (const directoryPath of templateDirs) {
    const entries = await listGithubRepositoryDirectory(requestJson, owner, repo, directoryPath, baseBranch, token);
    const templateEntry = (entries || [])
        .filter((entry) => entry && entry.type === "file" && /\.(md|txt)$/i.test(entry.name || ""))
        .sort((left, right) => cleanGithubValue(left.path).localeCompare(cleanGithubValue(right.path)))[0];
    if (!templateEntry || !templateEntry.path) {
      continue;
    }
    const content = await getGithubRepositoryFile(requestJson, owner, repo, templateEntry.path, baseBranch, token);
    if (content) {
      return {body: content, source: `repository_template:${cleanGithubValue(templateEntry.path)}`};
    }
  }

  return {
    body: defaultPullRequestBody(),
    source: "fallback_template",
  };
}

async function getGithubRepositoryFile(requestJson, owner, repo, filePath, ref, token) {
  let data;
  try {
    data = await requestJson(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeGithubContentPath(filePath)}?ref=${encodeURIComponent(ref)}`,
        token,
        {failureError: "github_repository_file_lookup_failed"},
    );
  } catch (error) {
    if (error && error.status === 404) {
      return "";
    }
    throw error;
  }

  if (!data || Array.isArray(data) || cleanGithubValue(data.type) !== "file") {
    return "";
  }
  if (cleanGithubValue(data.encoding) !== "base64") {
    return "";
  }

  try {
    return Buffer.from(String(data.content || "").replace(/\n/g, ""), "base64").toString("utf8");
  } catch (error) {
    throw httpError(502, "github_repository_file_decode_failed", error);
  }
}

async function listGithubRepositoryDirectory(requestJson, owner, repo, directoryPath, ref, token) {
  try {
    const data = await requestJson(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeGithubContentPath(directoryPath)}?ref=${encodeURIComponent(ref)}`,
        token,
        {failureError: "github_repository_directory_lookup_failed"},
    );
    return Array.isArray(data) ? data : [];
  } catch (error) {
    if (error && error.status === 404) {
      return [];
    }
    throw error;
  }
}

async function createGithubPullRequest(fetchImpl, {owner, repo, token, title, body, head, base, draft}) {
  return requestGithubJson(fetchImpl, `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, token, {
    method: "POST",
    body: {
      title,
      head,
      base,
      body,
      draft: Boolean(draft),
    },
    failureError: "github_pull_request_create_failed",
  });
}

async function requestGithubJson(fetchImpl, url, token, options = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: options.method || "GET",
      headers: {
        "accept": "application/vnd.github+json",
        "authorization": `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "mapahce-functions",
        "x-github-api-version": "2022-11-28",
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch (error) {
    throw httpError(502, options.failureError || "github_request_failed", error);
  }

  const data = await response.json().catch(() => ({}));
  if (response.status === 404) {
    throw httpError(404, cleanGithubApiMessage(data) || options.failureError || "github_request_failed");
  }
  if (!response.ok) {
    const status = response.status === 422 || response.status === 409 ? 400 : 502;
    throw httpError(status, cleanGithubApiMessage(data) || options.failureError || "github_request_failed");
  }
  return data;
}

function defaultSecretReader(secret) {
  try {
    return secret.value();
  } catch (error) {
    return "";
  }
}

function secretValue(secret, readSecret) {
  try {
    return readSecret(secret);
  } catch (error) {
    return "";
  }
}

function encodeJwtSegment(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function cleanGithubApiMessage(value) {
  if (!value || typeof value !== "object") {
    return "";
  }
  const message = cleanGithubValue(value.message || "");
  const detail = Array.isArray(value.errors) ? value.errors.map((entry) => {
    if (!entry || typeof entry !== "object") {
      return cleanGithubValue(entry);
    }
    return cleanGithubValue(entry.message || entry.code || entry.field || entry.resource);
  }).filter(Boolean)[0] : "";
  return [message, detail].filter(Boolean).join(": ");
}

function encodeGithubContentPath(value) {
  return String(value || "").split("/").filter(Boolean).map((part) => encodeURIComponent(part)).join("/");
}

function defaultPullRequestBody() {
  return [
    "## Summary",
    "- ",
    "",
    "## Testing",
    "- Not run (fill in)",
  ].join("\n");
}

async function safeReadGithubErrorBody(response) {
  try {
    const text = await response.text();
    return cleanGithubErrorBody(text);
  } catch (error) {
    return "";
  }
}

function cleanGithubErrorBody(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function cleanGithubToken(value) {
  const token = String(value || "").trim();
  if (!token) {
    throw httpError(502, "github_installation_token_failed");
  }
  return token;
}

function cleanGithubTimestamp(value) {
  const timestamp = String(value || "").trim();
  return timestamp || "";
}

function normalizeGithubTokenPermissions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.entries(value).reduce((result, [key, permission]) => {
    const normalizedKey = cleanGithubValue(key);
    const normalizedPermission = cleanGithubValue(permission);
    if (normalizedKey && normalizedPermission) {
      result[normalizedKey] = normalizedPermission;
    }
    return result;
  }, {});
}

function cleanGithubValue(value) {
  return String(value || "").trim().slice(0, 256);
}

function cleanGithubNumericId(value) {
  const normalized = String(value == null ? "" : value).trim();
  return /^\d+$/.test(normalized) ? normalized : "";
}

module.exports = {
  cleanGithubApiMessage,
  cleanGithubErrorBody,
  cleanGithubNumericId,
  cleanGithubValue,
  createGithubClientService,
  encodeGithubContentPath,
  normalizeGithubInstallationId,
  normalizeGithubTokenPermissions,
};

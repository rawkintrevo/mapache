"use strict";

const logger = require("firebase-functions/logger");
const {auth} = require("./backendContext");

const IMAGE_DIGEST_CACHE_TTL_MS = 60 * 1000;

function createRunnerImageFreshnessService(dependencies = {}) {
  const clientAuth = dependencies.auth || auth;
  const now = dependencies.now || (() => Date.now());
  const cache = new Map();

  async function getCurrentRunnerImageDigest(image) {
    const reference = parseRunnerImageReference(image);
    if (!reference) return null;
    const cacheKey = reference.image;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now()) return cached.promise;

    const promise = fetchCurrentRunnerImageDigest(reference, clientAuth).catch((error) => {
      logger.warn("runner image digest lookup failed", {
        image: reference.image,
        error: error.message || String(error),
      });
      return null;
    });
    cache.set(cacheKey, {expiresAt: now() + IMAGE_DIGEST_CACHE_TTL_MS, promise});
    return promise;
  }

  return {getCurrentRunnerImageDigest};
}

function parseRunnerImageReference(image) {
  const cleanImage = String(image || "").trim();
  const match = cleanImage.match(/^([^/]+)-docker\.pkg\.dev\/([^/]+)\/([^/]+)\/(.+):([^:@]+)$/);
  if (!match) return null;
  const [, host, project, repository, imagePath, tag] = match;
  return {
    host,
    image: cleanImage,
    imagePackage: `${host}-docker.pkg.dev/${project}/${repository}/${imagePath}`,
    location: host,
    project,
    repository,
    tag,
  };
}

async function fetchCurrentRunnerImageDigest(reference, clientAuth) {
  const client = await clientAuth.getClient();
  let pageToken = "";
  for (let page = 0; page < 10; page++) {
    const query = new URLSearchParams({pageSize: "1000"});
    if (pageToken) query.set("pageToken", pageToken);
    const url = `https://artifactregistry.googleapis.com/v1/projects/${encodeURIComponent(reference.project)}/locations/${encodeURIComponent(reference.location)}/repositories/${encodeURIComponent(reference.repository)}/dockerImages?${query}`;
    const response = await client.request({url, method: "GET"});
    const image = (response.data?.dockerImages || []).find((candidate) =>
      candidate.package === reference.imagePackage &&
      Array.isArray(candidate.tags) &&
      candidate.tags.includes(reference.tag),
    );
    if (image) return image.uri || null;
    pageToken = String(response.data?.nextPageToken || "");
    if (!pageToken) break;
  }
  return null;
}

function getSessionImageFreshness(session = {}, currentDigest) {
  if (String(session.status || "").trim().toLowerCase() !== "running") return "unknown";
  const deployedDigest = normalizeDigest(session.runnerImageDigest);
  const latestDigest = normalizeDigest(currentDigest === undefined ? session.runnerImageCurrentDigest : currentDigest);
  if (!deployedDigest || !latestDigest) return "unknown";
  return deployedDigest === latestDigest ? "latest" : "stale";
}

function normalizeDigest(value) {
  const match = String(value || "").trim().match(/@sha256:[0-9a-f]{64}$/i);
  return match ? match[0].toLowerCase() : "";
}

module.exports = {
  createRunnerImageFreshnessService,
  getSessionImageFreshness,
  normalizeDigest,
  parseRunnerImageReference,
};

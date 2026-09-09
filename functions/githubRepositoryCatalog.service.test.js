"use strict";

const assert = require("assert");
const {
  createGithubRepositoryCatalogService,
  githubRepoMapKey,
  normalizeGithubConnectedRepo,
  normalizeStoredGithubRepositoryRecord,
} = require("./githubRepositoryCatalog.service");

assert.deepStrictEqual(normalizeStoredGithubRepositoryRecord("uid-1", "42", "99", {
  ownerUid: "uid-1",
  installationId: "42",
  ownerLogin: "octo-org",
  name: "mapache",
  defaultBranch: "main",
  private: true,
  cloneUrl: "https://github.com/octo-org/mapache.git",
  htmlUrl: "https://github.com/octo-org/mapache",
}), {
  repoId: "99",
  owner: "octo-org",
  name: "mapache",
  fullName: "octo-org/mapache",
  defaultBranch: "main",
  private: true,
  cloneUrl: "https://github.com/octo-org/mapache.git",
  htmlUrl: "https://github.com/octo-org/mapache",
});
assert.strictEqual(normalizeStoredGithubRepositoryRecord("uid-1", "42", "99", {ownerUid: "other"}), null);
assert.strictEqual(normalizeStoredGithubRepositoryRecord("uid-1", "42", "99", {installationId: "7"}), null);
assert.strictEqual(normalizeStoredGithubRepositoryRecord("uid-1", "42", "99", {accessible: false}), null);

assert.strictEqual(githubRepoMapKey({id: "99"}), "id:99");
assert.strictEqual(githubRepoMapKey({owner: {login: "Octo"}, name: "Mapache"}), "name:octo/mapache");
assert.strictEqual(githubRepoMapKey({full_name: "Octo/Mapache"}), "name:octo/mapache");

assert.deepStrictEqual(normalizeGithubConnectedRepo(
    {installationId: "42", githubAccountLogin: "octo-org", repositorySelection: "selected"},
    {
      id: "99",
      owner: {login: "octo-org"},
      name: "mapache",
      full_name: "octo-org/mapache",
      default_branch: "main",
      private: false,
      visibility: "public",
      clone_url: "https://github.com/octo-org/mapache.git",
      html_url: "https://github.com/octo-org/mapache",
    },
    null,
    "all",
), {
  repoId: "99",
  installationId: "42",
  owner: "octo-org",
  name: "mapache",
  fullName: "octo-org/mapache",
  defaultBranch: "main",
  private: false,
  visibility: "public",
  cloneUrl: "https://github.com/octo-org/mapache.git",
  repoUrl: "https://github.com/octo-org/mapache",
  repositorySelection: "all",
});
assert.strictEqual(normalizeGithubConnectedRepo({installationId: "42"}, {owner: {login: ""}}, null, ""), null);

const repositoryDocs = [{
  id: "99",
  data: () => ({
    ownerUid: "uid-1",
    installationId: "42",
    ownerLogin: "octo-org",
    name: "mapache",
    defaultBranch: "main",
    private: true,
    cloneUrl: "https://github.com/octo-org/mapache.git",
    htmlUrl: "https://github.com/octo-org/mapache",
  }),
}];
const repositoryCollection = {get: async () => ({docs: repositoryDocs})};
const installationCollection = {
  get: async () => ({docs: [{
    id: "42",
    data: () => ({ownerUid: "uid-1", installationStatus: "active", githubAccountLogin: "octo-org", repositorySelection: "selected"}),
  }]}),
  doc: () => ({collection: () => repositoryCollection}),
};
const userDoc = {
  get: async () => ({exists: true, data: () => ({connectionStatus: "connected", installationIds: ["42"]})}),
  collection: () => installationCollection,
};
const db = {collection: () => ({doc: () => userDoc})};
const catalog = createGithubRepositoryCatalogService({
  db,
  githubClient: {
    isGithubAppConfigured: () => true,
    createGithubInstallationToken: async () => ({token: "token", repositorySelection: "selected"}),
    listGithubInstallationRepositories: async () => [{
      id: "99",
      owner: {login: "octo-org"},
      name: "mapache",
      full_name: "octo-org/mapache",
    }],
  },
});

(async () => {
  assert.deepStrictEqual(await catalog.listConnectedRepos("uid-1"), {
    repos: [{
      repoId: "99",
      installationId: "42",
      owner: "octo-org",
      name: "mapache",
      fullName: "octo-org/mapache",
      defaultBranch: "main",
      private: true,
      visibility: "private",
      cloneUrl: "https://github.com/octo-org/mapache.git",
      repoUrl: "https://github.com/octo-org/mapache",
      repositorySelection: "selected",
    }],
  });
  console.log("github repository catalog service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

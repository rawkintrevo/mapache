"use strict";
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const {MAX_UPLOAD_BYTES, validateUpload, normalizeUploadOperationId, uploadsForWorkspace, createWorkspaceUploadsService, buildUploadsStorageTemplate} = require("./workspaceUploads.service");
const {routeRequest} = require("./apiRoutes.helpers");
const {dispatchApiRoute} = require("./apiDispatch.helpers");
const {UPLOAD_HOLD_MS} = require("./vmLegacyUploadAdmission.service");

function uploadAdmissionFixture(workspace) {
  const rows = new Map([["workspaces/w", {ownerUid: "u", ...workspace}]]);
  const ref = path => ({path, collection: segment => ref(path + "/" + segment),
    doc: id => ref(path + "/" + id)});
  const db = {collection: ref, runTransaction: async fn => fn({
    get: async ({path}) => ({exists: rows.has(path), data: () => rows.get(path), get: key => rows.get(path)?.[key]}),
    create: ({path}, value) => {
      assert.equal(rows.has(path), false);
      rows.set(path, value);
    },
    set: ({path}, value) => rows.set(path, {...rows.get(path), ...value}),
    delete: ({path}) => rows.delete(path),
  })};
  return {db, rows};
}

(async () => {
  assert.deepEqual(routeRequest("/api/workspaces/w/uploads"), {name: "workspaceUploads", workspaceId: "w"});
  for (const name of ["../x", "a/b", "a\\b", ".", "..", "", "x\n", "x\0", "a".repeat(241)]) {
    assert.throws(() => validateUpload({name, size: 1}), /invalid_upload_filename/);
  }
  for (const size of [0, -1, 1.5, "20", MAX_UPLOAD_BYTES + 1]) {
    assert.throws(() => validateUpload({name: "a.csv", size}), /upload_size/);
  }
  assert.equal(normalizeUploadOperationId("resume_123"), "resume_123");
  assert.equal(normalizeUploadOperationId(), "");
  assert.throws(() => normalizeUploadOperationId("bad operation"), /invalid_upload_operation/);
  assert.deepEqual(validateUpload({name: "résumé data.csv", size: MAX_UPLOAD_BYTES}), {name: "résumé data.csv", size: MAX_UPLOAD_BYTES});
  for (const storagePrefix of ["../a", "/a", "a,,b", "a//b"]) assert.throws(() => uploadsForWorkspace({storagePrefix}));
  let exists = false;
  const calls = [];
  const workspace = {bucket: "bucket", storagePrefix: "workspaces/u/w"};
  const {db, rows} = uploadAdmissionFixture(workspace);
  const pending = () => [...rows.keys()].filter(key => key.includes("/pending/"));
  let failMint = false;
  const storage = {bucket: (bucket) => ({file: (path) => ({
    exists: async () => [exists],
    createResumableUpload: async (options) => {
      assert.equal(pending().length, 1);
      calls.push({bucket, path, options});
      if (failMint) throw Error("storage_response_lost");
      return ["https://storage.googleapis.com/upload-session"];
    },
    save: async (body, options) => calls.push({bucket, path, body, options}),
  })})};
  const service = createWorkspaceUploadsService({db, storage, requireWorkspace: async (uid, wid) => {
    if (uid !== "u" || wid !== "w") throw new Error("workspace_forbidden");
    return workspace;
  }});
  await assert.rejects(service.createUpload("other", "w", {name: "x", size: 10}), /forbidden/);
  assert.equal(calls.length, 0);
  rows.set("vmMigrationFences_v2/w", {});
  await assert.rejects(service.createUpload("u", "w", {name: "x", size: 10}), {publicMessage: "workspace_vm_migration_active"});
  assert.equal(calls.length, 0);
  assert.equal(pending().length, 0);
  rows.delete("vmMigrationFences_v2/w");
  const before = Date.now();
  const result = await service.createUpload("u", "w", {name: "x.csv", size: 10, bucket: "evil", path: "/etc"}, "https://mapache.tools");
  assert.equal(pending().length, 0);
  assert.ok(rows.get("vmLegacyUploads_v2/w").drainUntilMs >= before + UPLOAD_HOLD_MS);
  assert.ok(!JSON.stringify([...rows]).includes("https://storage.googleapis.com/upload-session"));
  assert.equal(result.path, "/uploads/x.csv");
  assert.equal(calls[0].path, "workspaces/u/w/.mapache-internal/uploads/x.csv");
  assert.deepEqual(calls[0].options.preconditionOpts, {ifGenerationMatch: 0});
  assert.equal(calls[0].options.metadata.contentLength, 10);
  assert.equal(calls[0].options.origin, "https://mapache.tools");
  exists = true;
  await assert.rejects(service.createUpload("u", "w", {name: "x.csv", size: 10}), /already_exists/);
  exists = false;
  const template = await buildUploadsStorageTemplate(workspace, storage);
  assert.deepEqual(template.containers[0].volumeMounts, [{name: "workspace-uploads", mountPath: "/uploads"}]);
  assert.equal(template.volumes[0].gcs.readOnly, true);
  assert.equal(template.volumes[0].gcs.mountOptions[0], "only-dir=workspaces/u/w/.mapache-internal/uploads");
  assert.notEqual(uploadsForWorkspace({...workspace, storagePrefix: "workspaces/u/other"}).prefix, uploadsForWorkspace(workspace).prefix);
  let response;
  const res = {status: (status) => ({json: (body) => {response = {status, body};}})};
  await dispatchApiRoute({route: {name: "workspaceUploads", workspaceId: "w"}, user: {uid: "u"},
    req: {method: "POST", body: {name: "route.csv", size: 1}, get: () => "https://mapache.tools"}, res,
    handlers: {createWorkspaceUpload: service.createUpload}});
  assert.equal(response.status, 201);
  assert.equal(response.body.path, "/uploads/route.csv");
  failMint = true;
  await assert.rejects(service.createUpload("u", "w", {name: "lost.csv", size: 1}), /storage_response_lost/);
  assert.equal(pending().length, 1);

  const vmWorkspace = {
    id: "vm-workspace",
    canonicalSessionId: "session-1",
    runtimeProvider: {backend: "compute-engine", gateway: {baseUrl: "https://gateway.example"}},
  };
  const vmSession = {id: "session-1", serviceUrl: "https://gateway.example", browserAccessTokenSecret: "session-secret", agentRuntimeGeneration: 2};
  const vmService = createWorkspaceUploadsService({
    browserAccessTtlMs: 60_000,
    requireWorkspace: async () => vmWorkspace,
    sessionCollection: () => ({doc: () => ({get: async () => ({exists: true, id: vmSession.id, data: () => vmSession})})}),
    storage,
  });
  const vmUpload = await vmService.createUpload("u", "vm-workspace", {name: "vm.csv", size: 10, operationId: "resume_123"});
  const vmUrl = new URL(vmUpload.uploadUrl);
  const [payload, signature] = vmUrl.searchParams.get("mapache_access").split(".");
  const expected = crypto.createHmac("sha256", vmSession.browserAccessTokenSecret).update(payload).digest("base64url");
  assert.equal(signature, expected);
  assert.equal(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).sid, vmSession.id);
  assert.equal(vmUpload.operationId, "resume_123");
  assert.equal(vmUrl.pathname, "/workspace/uploads/resume_123");
  console.log("workspace uploads tests passed");
})().catch((error) => {console.error(error); process.exitCode = 1;});

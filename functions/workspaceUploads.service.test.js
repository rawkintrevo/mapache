"use strict";
const assert = require("node:assert/strict");
const {MAX_UPLOAD_BYTES, validateUpload, uploadsForWorkspace, createWorkspaceUploadsService, buildUploadsStorageTemplate} = require("./workspaceUploads.service");
const {routeRequest} = require("./apiRoutes.helpers");
const {dispatchApiRoute} = require("./apiDispatch.helpers");
(async () => {
  assert.deepEqual(routeRequest("/api/workspaces/w/uploads"), {name: "workspaceUploads", workspaceId: "w"});
  for (const name of ["../x", "a/b", "a\\b", ".", "..", "", "x\n", "x\0", "a".repeat(241)]) {
    assert.throws(() => validateUpload({name, size: 1}), /invalid_upload_filename/);
  }
  for (const size of [0, -1, 1.5, "20", MAX_UPLOAD_BYTES + 1]) {
    assert.throws(() => validateUpload({name: "a.csv", size}), /upload_size/);
  }
  assert.deepEqual(validateUpload({name: "résumé data.csv", size: MAX_UPLOAD_BYTES}), {name: "résumé data.csv", size: MAX_UPLOAD_BYTES});
  for (const storagePrefix of ["../a", "/a", "a,,b", "a//b"]) assert.throws(() => uploadsForWorkspace({storagePrefix}));
  let exists = false;
  const calls = [];
  const workspace = {bucket: "bucket", storagePrefix: "workspaces/u/w"};
  const storage = {bucket: (bucket) => ({file: (path) => ({
    exists: async () => [exists],
    createResumableUpload: async (options) => {calls.push({bucket, path, options}); return ["https://storage.googleapis.com/upload-session"];},
    save: async (body, options) => calls.push({bucket, path, body, options}),
  })})};
  const service = createWorkspaceUploadsService({storage, requireWorkspace: async (uid, wid) => {
    if (uid !== "u" || wid !== "w") throw new Error("workspace_forbidden");
    return workspace;
  }});
  await assert.rejects(service.createUpload("other", "w", {name: "x", size: 10}), /forbidden/);
  assert.equal(calls.length, 0);
  const result = await service.createUpload("u", "w", {name: "x.csv", size: 10, bucket: "evil", path: "/etc"}, "https://mapache.tools");
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
  console.log("workspace uploads tests passed");
})().catch((error) => {console.error(error); process.exitCode = 1;});

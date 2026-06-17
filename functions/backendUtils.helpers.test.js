"use strict";

const assert = require("assert");
const {
  cleanContentType,
  cleanName,
  cloudRunServiceName,
  contentTypeForPath,
  defaultPreviewStaticRoot,
  firebaseStorageBucket,
  httpError,
  isGoogleNotFound,
  latestTimestampMillis,
  normalizeServiceAccountEmail,
  normalizeStoragePrefix,
  positiveNumber,
  publicGoogleError,
  safeContentDispositionFilename,
  serialize,
  slugify,
  timestampMillis,
  toClientDoc,
  userPath,
  workspaceUploadBuffer,
} = require("./backendUtils.helpers");

assert.strictEqual(cleanName(" x ".repeat(200)).length, 256);
assert.strictEqual(cleanName("  Mapache  "), "Mapache");

assert.strictEqual(positiveNumber("2.5", 1), 2.5);
assert.strictEqual(positiveNumber("-1", 7), 7);
assert.strictEqual(positiveNumber("not-a-number", 9), 9);

const date = new Date("2026-06-17T12:34:56.000Z");
assert.strictEqual(timestampMillis(date), date.getTime());
assert.strictEqual(timestampMillis({toMillis: () => 123}), 123);
assert.strictEqual(timestampMillis({toDate: () => date}), date.getTime());
assert.strictEqual(timestampMillis("bad-date"), 0);
assert.strictEqual(latestTimestampMillis(1, date, "2026-06-18T00:00:00.000Z"), Date.parse("2026-06-18T00:00:00.000Z"));

assert.deepStrictEqual(serialize({
  createdAt: {toDate: () => date},
  nested: [{updatedAt: {toDate: () => date}}],
}), {
  createdAt: "2026-06-17T12:34:56.000Z",
  nested: [{updatedAt: "2026-06-17T12:34:56.000Z"}],
});
assert.deepStrictEqual(toClientDoc({
  id: "doc-1",
  data: () => ({name: "Workspace", createdAt: {toDate: () => date}}),
}), {
  id: "doc-1",
  name: "Workspace",
  createdAt: "2026-06-17T12:34:56.000Z",
});

assert.strictEqual(slugify(" My Workspace!! "), "my-workspace");
assert.strictEqual(slugify(""), "workspace");
assert.strictEqual(normalizeStoragePrefix("/workspaces/user/demo/"), "workspaces/user/demo");
assert.strictEqual(userPath("uid-1"), "users/uid-1");

const originalFirebaseConfig = process.env.FIREBASE_CONFIG;
process.env.FIREBASE_CONFIG = JSON.stringify({storageBucket: "mapache.appspot.com"});
assert.strictEqual(firebaseStorageBucket(), "mapache.appspot.com");
process.env.FIREBASE_CONFIG = "{bad json";
assert.strictEqual(firebaseStorageBucket(), "");
if (originalFirebaseConfig === undefined) delete process.env.FIREBASE_CONFIG;
else process.env.FIREBASE_CONFIG = originalFirebaseConfig;

assert.strictEqual(contentTypeForPath("index.html"), "text/html; charset=utf-8");
assert.strictEqual(contentTypeForPath("README.md"), "text/markdown; charset=utf-8");
assert.strictEqual(contentTypeForPath("archive.bin"), "text/plain; charset=utf-8");
assert.strictEqual(cleanContentType(" text/plain "), "text/plain");
assert.strictEqual(cleanContentType("text/plain\r\nx-bad: y"), "");
assert.strictEqual(safeContentDispositionFilename("bad\"name\n.txt"), "bad_name_.txt");
assert.deepStrictEqual(workspaceUploadBuffer({body: "hello"}), Buffer.from("hello"));
assert.deepStrictEqual(workspaceUploadBuffer({rawBody: Buffer.from("raw")}), Buffer.from("raw"));

assert.strictEqual(defaultPreviewStaticRoot({preview: true}), "/workspace/build");
assert.strictEqual(defaultPreviewStaticRoot({preview: false}), null);

assert.strictEqual(
    normalizeServiceAccountEmail("Mapache-Runner@Pi-Agents-Cloud.iam.gserviceaccount.com"),
    "mapache-runner@pi-agents-cloud.iam.gserviceaccount.com",
);
assert.throws(() => normalizeServiceAccountEmail("not-an-email"), /Invalid service account email/);

const originalProject = process.env.GCLOUD_PROJECT;
process.env.GCLOUD_PROJECT = "pi-agents-cloud";
assert.strictEqual(
    cloudRunServiceName("us-central1", "session-123"),
    "projects/pi-agents-cloud/locations/us-central1/services/session-123",
);
if (originalProject === undefined) delete process.env.GCLOUD_PROJECT;
else process.env.GCLOUD_PROJECT = originalProject;

assert.strictEqual(publicGoogleError({message: "failed"}), "failed");
assert.strictEqual(publicGoogleError({response: {data: {error: {message: "denied"}}}}), "{\"error\":{\"message\":\"denied\"}}");
assert.strictEqual(isGoogleNotFound({code: 404}), true);
assert.strictEqual(isGoogleNotFound({response: {data: {error: {code: 404}}}}), true);
assert.strictEqual(Boolean(isGoogleNotFound({code: 403})), false);

const error = httpError(409, "conflict", new Error("cause"));
assert.strictEqual(error.status, 409);
assert.strictEqual(error.publicMessage, "conflict");
assert.strictEqual(error.cause.message, "cause");

console.log("backend utils helper tests passed");

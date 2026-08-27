"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  MAX_REPLAY_BYTES,
  MAX_REPLAY_MESSAGES,
  createPiChatTranscriptService,
} = require("./piChat.service");

async function tempTranscript(initial = "") {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mapache-pi-chat-"));
  const file = path.join(root, "session.jsonl");
  if (initial !== null) await fsp.writeFile(file, initial);
  return {root, file};
}

function line({id, parentId, role = "user", content = id, type = "message"}) {
  return JSON.stringify({
    type,
    id,
    ...(parentId ? {parentId} : {}),
    timestamp: `2026-08-27T14:00:${String(id).replace(/\D/g, "").padStart(2, "0") || "00"}.000Z`,
    message: {role, content},
  });
}

async function cleanup(root) {
  await fsp.rm(root, {recursive: true, force: true});
}

async function makeService(file, events) {
  const service = createPiChatTranscriptService({
    config: {piSessionDir: path.dirname(file)},
    pollIntervalMs: 100000,
  });
  service.subscribe((event) => events.push(event));
  await service.poll();
  return service;
}

test("reports waiting, discovers a delayed transcript, and replays complete lines", async () => {
  const {root, file} = await tempTranscript(null);
  const events = [];
  const service = createPiChatTranscriptService({
    config: {piSessionDir: root},
    pollIntervalMs: 100000,
  });
  service.subscribe((event) => events.push(event));
  await service.poll();
  assert.equal(events[0].status, "waiting_for_transcript");

  await fsp.writeFile(file, `${line({id: "u1"})}\n`);
  await service.poll();
  assert.deepEqual(events.find((event) => event.type === "snapshot").messages.map((message) => message.id), ["u1"]);
  assert.equal(events.at(-1).status, "ready");
  service.stop();
  await cleanup(root);
});

test("bounds replay by displayable messages and source bytes", async () => {
  const records = [];
  let parentId = "";
  for (let index = 0; index < MAX_REPLAY_MESSAGES + 5; index += 1) {
    const id = `u${index}`;
    records.push(line({id, parentId, content: "x"}));
    parentId = id;
  }
  const {root, file} = await tempTranscript(`${records.join("\n")}\n`);
  const events = [];
  const service = await makeService(file, events);
  const snapshot = events.find((event) => event.type === "snapshot");
  assert.equal(snapshot.messages.length, MAX_REPLAY_MESSAGES);
  assert.equal(snapshot.messages[0].id, "u5");

  await fsp.appendFile(file, `${line({id: "bytes", parentId, content: "x".repeat(MAX_REPLAY_BYTES)})}\n`);
  await service.poll();
  assert.ok(service.getSnapshot().length <= MAX_REPLAY_MESSAGES);
  service.stop();
  await cleanup(root);
});

test("emits appended lines once and holds an incomplete final line", async () => {
  const first = line({id: "u1"});
  const second = line({id: "a1", parentId: "u1", role: "assistant", content: "answer"});
  const {root, file} = await tempTranscript(`${first}\n${second.slice(0, 20)}`);
  const events = [];
  const service = await makeService(file, events);
  assert.deepEqual(service.getSnapshot().map((message) => message.id), ["u1"]);

  await fsp.appendFile(file, `${second.slice(20)}\n`);
  await service.poll();
  const messages = events.filter((event) => event.type === "message").map((event) => event.message.id);
  assert.deepEqual(messages, ["a1"]);

  await fsp.appendFile(file, `${second}\n`);
  await service.poll();
  assert.deepEqual(events.filter((event) => event.type === "message").map((event) => event.message.id), ["a1"]);
  service.stop();
  await cleanup(root);
});

test("rebuilds on truncate and replacement without leaking old messages", async () => {
  const {root, file} = await tempTranscript(`${line({id: "old"})}\n`);
  const events = [];
  const service = await makeService(file, events);

  await fsp.writeFile(file, `${line({id: "new"})}\n`);
  await service.poll();
  const truncateReset = events.filter((event) => event.type === "reset").at(-1);
  assert.deepEqual(truncateReset.messages.map((message) => message.id), ["new"]);

  const replacement = path.join(root, "replacement.jsonl");
  await fsp.writeFile(replacement, `${line({id: "replacement"})}\n`);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await fsp.utimes(replacement, new Date(), new Date(Date.now() + 1000));
  await fsp.rename(replacement, file);
  await service.poll();
  assert.deepEqual(service.getSnapshot().map((message) => message.id), ["replacement"]);
  assert.equal(events.filter((event) => event.type === "reset").length, 2);
  service.stop();
  await cleanup(root);
});

test("replays the active parent branch and emits reset after a branch switch", async () => {
  const source = [
    line({id: "u1"}),
    line({id: "a1", parentId: "u1", role: "assistant", content: "first"}),
    line({id: "u2", parentId: "u1"}),
    line({id: "a2", parentId: "u2", role: "assistant", content: "second"}),
  ].join("\n") + "\n";
  const {root, file} = await tempTranscript(source);
  const events = [];
  const service = await makeService(file, events);
  assert.deepEqual(service.getSnapshot().map((message) => message.id), ["u1", "u2", "a2"]);

  await fsp.appendFile(file, `${line({id: "u3", parentId: "a1"})}\n${line({id: "a3", parentId: "u3", role: "assistant", content: "third"})}\n`);
  await service.poll();
  assert.equal(events.at(-1).type, "reset");
  assert.deepEqual(service.getSnapshot().map((message) => message.id), ["u1", "a1", "u3", "a3"]);
  service.stop();
  await cleanup(root);
});

test("skips malformed lines, stops when unsubscribed, and does not log paths", async () => {
  const {root, file} = await tempTranscript(`not-json\n${line({id: "valid"})}\n`);
  const events = [];
  const service = await makeService(file, events);
  assert.deepEqual(service.getSnapshot().map((message) => message.id), ["valid"]);
  const unsubscribe = service.subscribe(() => {});
  unsubscribe();
  assert.equal(service.getStatus(), "ready");
  service.stop();
  await cleanup(root);
});

test("exports replay limits as named constants", () => {
  assert.equal(MAX_REPLAY_MESSAGES, 200);
  assert.equal(MAX_REPLAY_BYTES, 1024 * 1024);
});

"use strict";

// Execute inside the isolated fixture container only, then repeat in verify mode
// after replacing compute. Never accepts an arbitrary data-root argument.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const {execFileSync} = require("node:child_process");
const root = "/var/lib/mapache/workspace";
const marker = JSON.parse(fs.readFileSync(path.join(root, ".mapache-vm-disk.json")));
assert.equal(marker.workspaceId, "vm-proof-605");
assert.equal(marker.ownerUid, "vm-proof-owner");
const dir = path.join(root, "workspace", "persistence-proof");
const run = (command, args) => execFileSync(command, args, {cwd: dir, encoding: "utf8"}).trim();
const mode = process.argv[2];
assert.ok(["seed", "verify"].includes(mode));
if (mode === "seed") {
  fs.mkdirSync(dir, {recursive: true});
  assert.equal(fs.existsSync(path.join(dir, "proof.json")), false, "refuse to overwrite prior proof");
  run("git", ["init", "-q"]);
  fs.writeFileSync(path.join(dir, "tracked"), "committed\n");
  run("git", ["add", "tracked"]);
  run("git", ["-c", "user.email=fixture@example.invalid", "-c", "user.name=VM fixture", "commit", "-qm", "fixture"]);
  fs.appendFileSync(path.join(dir, "tracked"), "dirty\n");
  fs.writeFileSync(path.join(dir, "untracked"), "preserve me\n", {mode: 0o600});
  fs.symlinkSync("untracked", path.join(dir, "link"));
  fs.writeFileSync(path.join(dir, "native.c"), '#include <stdio.h>\nint main(){puts("durable-native-tool");return 0;}\n');
  run("gcc", ["native.c", "-o", "native-tool"]);
  run("python3", ["-c", "import sqlite3; c=sqlite3.connect('proof.sqlite'); c.execute('create table proof(value text)'); c.execute(\"insert into proof values ('durable-sqlite')\"); c.commit(); c.close()"]);
  const proof = {gitHead: run("git", ["rev-parse", "HEAD"]), createdAt: new Date().toISOString()};
  fs.writeFileSync(path.join(dir, "proof.tmp"), JSON.stringify(proof));
  fs.renameSync(path.join(dir, "proof.tmp"), path.join(dir, "proof.json"));
  run("sync", []);
}
const proof = JSON.parse(fs.readFileSync(path.join(dir, "proof.json")));
assert.equal(run("git", ["rev-parse", "HEAD"]), proof.gitHead);
assert.equal(fs.readFileSync(path.join(dir, "tracked"), "utf8"), "committed\ndirty\n");
assert.equal(fs.readFileSync(path.join(dir, "link"), "utf8"), "preserve me\n");
assert.equal(fs.readlinkSync(path.join(dir, "link")), "untracked");
assert.equal(fs.statSync(path.join(dir, "untracked")).mode & 0o777, 0o600);
assert.equal(run("./native-tool", []), "durable-native-tool");
assert.equal(run("python3", ["-c", "import sqlite3; c=sqlite3.connect('proof.sqlite'); print(c.execute('select value from proof').fetchone()[0]); c.close()"]), "durable-sqlite");
run("python3", ["-c", "import fcntl; f=open('lock','w'); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB); fcntl.flock(f,fcntl.LOCK_UN)"]);
console.log(JSON.stringify({ok: true, mode, workspaceId: marker.workspaceId, gitHead: proof.gitHead, nativeTool: true, sqlite: true, permissions: true, symlink: true, lock: true}));

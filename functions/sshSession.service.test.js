"use strict";

const assert = require("assert");
const {createSshSessionService} = require("./sshSession.service");

const calls = [];
const sshSession = {
  data: () => ({
    sessionType: "ssh",
    terminalKind: "ssh",
    serviceUrl: "https://runner.example",
    shutdownToken: "shutdown-token",
  }),
};
const service = createSshSessionService({
  requireSession: async (...args) => {
    calls.push({kind: "requireSession", args});
    return {sessionSnap: sshSession};
  },
  requestRunnerJson: async (session, route, options) => {
    calls.push({kind: "runner", session, route, options});
    return {ok: true};
  },
});

(async () => {
  assert.deepStrictEqual(await service.listSshSessionFiles("user-1", "workspace-1", "session-1", "src"), {ok: true});
  assert.deepStrictEqual(await service.readSshSessionFile("user-1", "workspace-1", "session-1", "src/app.js"), {ok: true});
  assert.deepStrictEqual(await service.saveSshSessionFile("user-1", "workspace-1", "session-1", "src/app.js", {content: "updated"}), {ok: true});
  assert.deepStrictEqual(await service.listSshSessionForwards("user-1", "workspace-1", "session-1"), {ok: true});
  assert.deepStrictEqual(await service.createSshSessionForward("user-1", "workspace-1", "session-1", {port: 5173}), {ok: true});
  assert.deepStrictEqual(await service.closeSshSessionForward("user-1", "workspace-1", "session-1", 5173), {ok: true});

  assert.deepStrictEqual(calls.map((call) => call.kind), [
    "requireSession", "runner", "requireSession", "runner", "requireSession", "runner",
    "requireSession", "runner", "requireSession", "runner", "requireSession", "runner",
  ]);
  assert.deepStrictEqual(calls[1].options, {unavailableError: "runner_ssh_files_unavailable"});
  assert.deepStrictEqual(calls[3].options, {unavailableError: "runner_ssh_file_unavailable"});
  assert.deepStrictEqual(calls[5].options, {
    method: "PUT",
    body: {content: "updated"},
    unavailableError: "runner_ssh_file_save_unavailable",
  });
  assert.strictEqual(calls[9].options.method, "POST");
  assert.deepStrictEqual(calls[9].options.body, {port: 5173});
  assert.strictEqual(calls[11].route, "/ssh/ports/5173");
  assert.strictEqual(calls[11].options.method, "DELETE");

  const invalidService = createSshSessionService({
    requireSession: async () => ({sessionSnap: {data: () => ({terminalKind: "shell", serviceUrl: "https://runner.example", shutdownToken: "token"})}}),
    requestRunnerJson: async () => ({ok: true}),
  });
  await assert.rejects(
      invalidService.listSshSessionFiles("user-1", "workspace-1", "session-1"),
      (error) => error.status === 400 && error.publicMessage === "ssh_session_required",
  );

  const stoppedService = createSshSessionService({
    requireSession: async () => ({sessionSnap: {data: () => ({terminalKind: "ssh", serviceUrl: "", shutdownToken: "token"})}}),
    requestRunnerJson: async () => ({ok: true}),
  });
  await assert.rejects(
      stoppedService.listSshSessionForwards("user-1", "workspace-1", "session-1"),
      (error) => error.status === 409 && error.publicMessage === "session_not_running",
  );

  console.log("ssh session service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

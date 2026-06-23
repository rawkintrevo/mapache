"use strict";

const {listHarnessMetadata, resolveHarnessMetadata} = require("./metadata");

function createRunnerHarnessRegistry({codex, config, mcpConfig, pi, workspace}) {
  function resolveHarness(source = config) {
    const metadata = resolveHarnessMetadata(source);
    return {
      ...metadata,
      async materializeConfig() {
        return {ok: true, harness: metadata.id};
      },
      async materializeAuth() {
        if (!metadata.auth?.supported) return {ok: true, skipped: true};
        await workspace.synchronizeAuth({materialize: true});
        return {ok: true};
      },
      async materializeMcp() {
        return mcpConfig.materializeMcpConfig(metadata);
      },
      async materializeSkills() {
        if (metadata.id === "pi") {
          await pi.seedDefaultRuntimeSkills();
        } else if (metadata.id === "codex") {
          await codex.seedDefaultWorkspaceFiles();
        }
        return {ok: true};
      },
      async materializeSubagents() {
        return {ok: true, skipped: true};
      },
    };
  }

  return {
    listHarnesses: () => listHarnessMetadata().map((harness) => ({...harness})),
    resolveHarness,
  };
}

module.exports = {
  createRunnerHarnessRegistry,
};

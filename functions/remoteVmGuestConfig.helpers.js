"use strict";
const crypto = require("node:crypto");
const {httpError} = require("./backendUtils.helpers");
const BROKER_URL = "https://us-central1-pi-agents-cloud.cloudfunctions.net/remoteVmCredentials_v2";

function guestConfiguration({session, sessionId, descriptor, bootId, brokerUrl = BROKER_URL}) {
  const config = {
    OWNER_UID: session.ownerUid,
    WORKSPACE_ID: descriptor.workspaceId,
    SESSION_ID: sessionId,
    MAPACHE_AGENT_RUNTIME_GENERATION: String(descriptor.generation),
    MAPACHE_AGENT_RUNTIME_BOOT_INSTANCE_ID: bootId,
    SESSION_BROWSER_TOKEN_SECRET: session.browserAccessTokenSecret,
    SESSION_SHUTDOWN_TOKEN: session.shutdownToken,
    MAPACHE_REMOTE_CREDENTIAL_BROKER_URL: brokerUrl,
  };
  for (const [key, value] of Object.entries(config)) {
    const valid = typeof value === "string" && (key === "MAPACHE_REMOTE_CREDENTIAL_BROKER_URL" ? value === BROKER_URL :
      key === "SESSION_BROWSER_TOKEN_SECRET" || key === "SESSION_SHUTDOWN_TOKEN" ? /^[a-f0-9]{48,128}$/.test(value) :
      key === "MAPACHE_AGENT_RUNTIME_GENERATION" ? /^[1-9][0-9]{0,14}$/.test(value) : /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value));
    if (!valid) throw httpError(409, "remote_vm_guest_configuration_invalid");
  }
  return config;
}

function guestConfigurationId(config) {
  return crypto.createHash("sha256").update(JSON.stringify(Object.fromEntries(
    Object.keys(config).sort().map((key) => [key, config[key]]),
  ))).digest("hex");
}

module.exports = {guestConfiguration, guestConfigurationId};

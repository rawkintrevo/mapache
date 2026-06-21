"use strict";

const {cleanName, httpError} = require("./backendUtils.helpers");

function normalizeSshSessionPayload(payload = {}) {
  const source = payload.sshTarget && typeof payload.sshTarget === "object" ? payload.sshTarget : payload;
  const host = cleanHost(source.host);
  const username = cleanUser(source.username || source.user);
  const port = cleanPort(source.port || 22);
  const initialDirectory = cleanInitialDirectory(source.initialDirectory || source.cwd || "~");
  const authMode = cleanAuthMode(source.authMode || source.authType || source.authentication);
  const privateKey = cleanSecretMultiline(source.privateKey);
  const certificate = cleanSecretMultiline(source.certificate || source.publicCertificate || source.sshCertificate);
  const knownHosts = cleanSecretMultiline(source.knownHosts);
  const strictHostKeyChecking = source.strictHostKeyChecking !== false;

  if (!host) throw httpError(400, "ssh_host_required");
  if (!username) throw httpError(400, "ssh_username_required");
  if (!privateKey) throw httpError(400, "ssh_private_key_required");
  if (authMode === "certificate" && !certificate) throw httpError(400, "ssh_certificate_required");

  return {
    public: {
      host,
      port,
      username,
      initialDirectory,
      auth: {
        type: authMode === "certificate" ? "openssh-user-certificate" : "private-key",
        hasCertificate: Boolean(certificate),
        strictHostKeyChecking,
        hasKnownHosts: Boolean(knownHosts),
      },
      fileBrowser: {
        scope: "initial-directory",
        root: initialDirectory,
      },
    },
    secrets: {
      authMode,
      privateKey,
      certificate,
      knownHosts,
    },
  };
}

function cleanAuthMode(value) {
  const mode = cleanName(value || "private-key").toLowerCase();
  if (["certificate", "cert", "openssh-user-certificate", "signed-key"].includes(mode)) {
    return "certificate";
  }
  if (["private-key", "key", "public-key"].includes(mode)) {
    return "private-key";
  }
  throw httpError(400, "unsupported_ssh_auth_mode");
}

function cleanHost(value) {
  const host = String(value || "").trim();
  if (!host || host.length > 253) return "";
  if (!/^[A-Za-z0-9._:-]+$/.test(host)) return "";
  return host;
}

function cleanUser(value) {
  const user = String(value || "").trim();
  if (!user || user.length > 64) return "";
  if (!/^[A-Za-z0-9._-]+$/.test(user)) return "";
  return user;
}

function cleanPort(value) {
  const port = Number(value || 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw httpError(400, "invalid_ssh_port");
  }
  return port;
}

function cleanInitialDirectory(value) {
  const dir = String(value || "~").trim() || "~";
  if (dir.includes("\0") || dir.includes("\n") || dir.length > 512) {
    throw httpError(400, "invalid_ssh_initial_directory");
  }
  return dir;
}

function cleanSecretMultiline(value) {
  const text = String(value || "").replace(/\r\n/g, "\n").trim();
  if (!text) return "";
  if (text.includes("\0") || text.length > 20000) {
    throw httpError(400, "invalid_ssh_auth_material");
  }
  return `${text}\n`;
}

module.exports = {
  normalizeSshSessionPayload,
};

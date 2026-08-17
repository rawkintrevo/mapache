"use strict";

function isChromeSession(session = {}) {
  return Boolean(session.capabilities && session.capabilities.chrome);
}

function isActiveChromeSession(session = {}) {
  return isChromeSession(session) && !isTerminalStatus(session.status);
}

function findActiveChromeSession(docs = [], currentSessionId = "") {
  return docs.find((doc) => {
    const id = doc && (doc.id || doc.ref?.id) || "";
    return id !== currentSessionId && isActiveChromeSession(doc && typeof doc.data === "function" ? doc.data() : doc);
  }) || null;
}

function isTerminalStatus(status) {
  return ["stopped", "provision_failed", "needs_image", "needs_service", "update_failed", "stop_failed"].includes(
      String(status || "").trim(),
  );
}

module.exports = {
  findActiveChromeSession,
  isActiveChromeSession,
  isChromeSession,
};

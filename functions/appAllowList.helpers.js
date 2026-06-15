"use strict";

function parseAppAllowList(value) {
  return String(value || "")
      .split(/[\s,;]+/)
      .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean)
      .map(normalizeAllowListEntry)
      .filter(Boolean);
}

function normalizeAppAllowListConfig(data = {}) {
  const enabled = data && data.enabled === true;
  const entries = [
    ...parseAppAllowList(data && data.entries),
    ...parseAppAllowList(data && data.allowedEmails).map((entry) => ({...entry, type: "email"})),
    ...parseAppAllowList(data && data.allowedUids).map((entry) => ({...entry, type: "uid"})),
  ];

  return {enabled, entries};
}

function isAppAllowListConfigured(config = {}) {
  return normalizeAppAllowListConfig(config).enabled;
}

function isFirebaseTokenAllowed(token, config = {}) {
  const {enabled, entries} = normalizeAppAllowListConfig(config);
  if (!enabled) return true;

  const uid = String(token && token.uid || "").trim();
  const email = String(token && token.email || "").trim().toLowerCase();

  return entries.some((entry) => {
    if (entry.type === "uid") return uid && uid === entry.value;
    if (entry.type === "email") return email && email === entry.value;
    return false;
  });
}

function appAllowListStatus(config = {}) {
  const normalized = normalizeAppAllowListConfig(config);
  return {
    enabled: normalized.enabled,
    entryCount: normalized.entries.length,
  };
}

function normalizeAllowListEntry(entry) {
  const clean = String(entry || "").trim();
  if (!clean) return null;

  const prefixed = clean.match(/^(email|uid):(.+)$/i);
  if (prefixed) {
    const type = prefixed[1].toLowerCase();
    const value = prefixed[2].trim();
    if (!value) return null;
    return {
      type,
      value: type === "email" ? value.toLowerCase() : value,
    };
  }

  if (clean.includes("@")) {
    return {type: "email", value: clean.toLowerCase()};
  }
  return {type: "uid", value: clean};
}

module.exports = {
  appAllowListStatus,
  isAppAllowListConfigured,
  isFirebaseTokenAllowed,
  normalizeAppAllowListConfig,
  parseAppAllowList,
};

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

function isUserWhitelisted(user = {}, config = {}) {
  const uid = String(user.uid || user.id || "").trim();
  const email = String(user.email || "").trim().toLowerCase();
  return normalizeAppAllowListConfig(config).entries.some((entry) => (
    (entry.type === "uid" && uid && entry.value === uid) ||
    (entry.type === "email" && email && entry.value === email)
  ));
}

function setUserWhitelistStatus(config = {}, user = {}, whitelisted = false) {
  const uid = String(user.uid || user.id || "").trim();
  const email = String(user.email || "").trim().toLowerCase();
  const nextConfig = {
    ...config,
    enabled: whitelisted ? true : config.enabled === true,
    entries: removeUserFromAllowListValue(config.entries, uid, email).map(formatAllowListEntry),
    allowedEmails: removeUserFromAllowListValue(config.allowedEmails, uid, email)
        .filter((entry) => entry.type === "email")
        .map((entry) => entry.value),
    allowedUids: removeUserFromAllowListValue(config.allowedUids, uid, email)
        .filter((entry) => entry.type === "uid")
        .map((entry) => entry.value),
  };

  if (!whitelisted) return nextConfig;

  if (email) {
    nextConfig.allowedEmails = [...nextConfig.allowedEmails, email];
  } else if (uid) {
    nextConfig.allowedUids = [...nextConfig.allowedUids, uid];
  }
  return nextConfig;
}

function removeUserFromAllowListValue(value, uid, email) {
  return parseAppAllowList(value).filter((entry) => !(
    (entry.type === "uid" && uid && entry.value === uid) ||
    (entry.type === "email" && email && entry.value === email)
  ));
}

function formatAllowListEntry(entry) {
  if (entry.type === "email") return entry.value;
  return `${entry.type}:${entry.value}`;
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
  isUserWhitelisted,
  normalizeAppAllowListConfig,
  parseAppAllowList,
  setUserWhitelistStatus,
};

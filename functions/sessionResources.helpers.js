"use strict";

const catalog = require("./sessionResourceCatalog.json");

const SESSION_RESOURCE_ERROR_CODE = "invalid_session_resources";
const DEFAULT_SESSION_SIZE_KEY = "small";

function validateSessionResourceCatalog(candidate = catalog) {
  if (!candidate || candidate.version !== 1) throw new Error("invalid_session_resource_catalog_version");
  const pricing = candidate.pricing || {};
  if (!(Number(pricing.vcpuSecondUsd) > 0) || !(Number(pricing.gibSecondUsd) > 0)) {
    throw new Error("invalid_session_resource_catalog_pricing");
  }

  const cpuOptions = candidate.advanced && candidate.advanced.cpu;
  const memoryOptions = candidate.advanced && candidate.advanced.memory;
  if (!Array.isArray(cpuOptions) || !cpuOptions.length || !Array.isArray(memoryOptions) || !memoryOptions.length) {
    throw new Error("invalid_session_resource_catalog_options");
  }
  if (!Array.isArray(candidate.presets) || !candidate.presets.length) {
    throw new Error("invalid_session_resource_catalog_presets");
  }

  const keys = new Set();
  for (const preset of candidate.presets) {
    if (!preset || !/^[a-z]+$/.test(String(preset.key || "")) || keys.has(preset.key)) {
      throw new Error("invalid_session_resource_catalog_preset_key");
    }
    keys.add(preset.key);
    if (!cpuOptions.includes(preset.cpu) || !memoryOptions.includes(preset.memory)) {
      throw new Error("invalid_session_resource_catalog_preset_value");
    }
    if (!isValidSessionResourcePair(preset.cpu, preset.memory, candidate)) {
      throw new Error("invalid_session_resource_catalog_preset_pair");
    }
  }
  if (!keys.has(DEFAULT_SESSION_SIZE_KEY)) throw new Error("missing_small_session_preset");
  return true;
}

function parseMemoryGiB(value) {
  const match = String(value || "").trim().match(/^(\d+(?:\.\d+)?)(Mi|Gi|GiB)$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return match[2].toLowerCase() === "mi" ? amount / 1024 : amount;
}

function isValidSessionResourcePair(cpu, memory, candidate = catalog) {
  const normalizedCpu = String(cpu || "").trim();
  const normalizedMemory = String(memory || "").trim();
  const cpuOptions = candidate.advanced && candidate.advanced.cpu || [];
  const memoryOptions = candidate.advanced && candidate.advanced.memory || [];
  if (!cpuOptions.includes(normalizedCpu) || !memoryOptions.includes(normalizedMemory)) return false;

  const memoryGiB = parseMemoryGiB(normalizedMemory);
  const minMemory = Number(candidate.constraints?.minMemoryGiBByCpu?.[normalizedCpu] || 0);
  const maxMemory = Number(candidate.constraints?.maxMemoryGiBByCpu?.[normalizedCpu] || Infinity);
  return memoryGiB !== null && memoryGiB >= minMemory && memoryGiB <= maxMemory;
}

function getSessionSizePreset(key, candidate = catalog) {
  return (candidate.presets || []).find((preset) => preset.key === String(key || "").trim()) || null;
}

function inferSessionSize(cpu, memory, candidate = catalog) {
  const preset = (candidate.presets || []).find((item) => item.cpu === cpu && item.memory === memory);
  return preset ? preset.key : "custom";
}

function calculateEstimatedHourlyPrice(cpu, memory, candidate = catalog) {
  const cpuCount = Number(cpu);
  const memoryGiB = parseMemoryGiB(memory);
  if (!Number.isFinite(cpuCount) || cpuCount <= 0 || memoryGiB === null) return null;
  const pricing = candidate.pricing || {};
  return Number(((cpuCount * Number(pricing.vcpuSecondUsd) + memoryGiB * Number(pricing.gibSecondUsd)) * 3600).toFixed(6));
}

function calculateEstimatedUsageCostUsd(usage = {}, candidate = catalog) {
  const cpuSeconds = Number(usage.cpuSeconds || 0);
  const memoryGiBSeconds = Number(usage.memoryGbSeconds || 0);
  const pricing = candidate.pricing || {};
  return Number((cpuSeconds * Number(pricing.vcpuSecondUsd) + memoryGiBSeconds * Number(pricing.gibSecondUsd)).toFixed(6));
}

function normalizeSessionResources(payload = {}, options = {}) {
  const defaultResources = options.defaultResources === undefined ? getSessionSizePreset(DEFAULT_SESSION_SIZE_KEY) : options.defaultResources;
  const hasCpu = hasResourceValue(payload, "cpu");
  const hasMemory = hasResourceValue(payload, "memory");
  let cpu = hasCpu ? cleanResourceValue(payload.cpu) : "";
  let memory = hasMemory ? cleanResourceValue(payload.memory) : "";

  if (!hasCpu && !hasMemory && defaultResources) {
    cpu = cleanResourceValue(defaultResources.cpu);
    memory = cleanResourceValue(defaultResources.memory);
  } else if (!hasCpu || !hasMemory) {
    throw invalidSessionResourcesError("partial_resource_payload");
  }

  if (!isValidSessionResourcePair(cpu, memory)) {
    throw invalidSessionResourcesError("unsupported_resource_pair");
  }
  return {cpu, memory};
}

function hasResourceValue(payload, key) {
  return Boolean(payload && Object.prototype.hasOwnProperty.call(payload, key) && cleanResourceValue(payload[key]));
}

function cleanResourceValue(value) {
  return String(value || "").trim().slice(0, 32);
}

function invalidSessionResourcesError(reason) {
  const error = new Error(SESSION_RESOURCE_ERROR_CODE);
  error.code = SESSION_RESOURCE_ERROR_CODE;
  error.reason = reason;
  return error;
}

validateSessionResourceCatalog();

module.exports = {
  DEFAULT_SESSION_SIZE_KEY,
  SESSION_RESOURCE_ERROR_CODE,
  calculateEstimatedHourlyPrice,
  calculateEstimatedUsageCostUsd,
  getSessionSizePreset,
  inferSessionSize,
  isValidSessionResourcePair,
  normalizeSessionResources,
  parseMemoryGiB,
  validateSessionResourceCatalog,
};

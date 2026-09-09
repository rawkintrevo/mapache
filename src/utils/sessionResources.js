import catalog from "../../functions/sessionResourceCatalog.json";

export const sessionResourceCatalog = catalog;
export const sessionSizePresets = Object.freeze(catalog.presets.map((preset) => Object.freeze({...preset})));
export const sessionCpuOptions = Object.freeze([...catalog.advanced.cpu]);
export const sessionMemoryOptions = Object.freeze([...catalog.advanced.memory]);
export const pricingSourceUrl = catalog.pricing.sourceUrl;

function normalizeResourceValue(value) {
  return String(value || "").trim();
}

export function parseMemoryGiB(value) {
  const match = normalizeResourceValue(value).match(/^(\d+(?:\.\d+)?)(Mi|Gi|GiB)$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return match[2].toLowerCase() === "mi" ? amount / 1024 : amount;
}

export function isValidSessionResourcePair(cpu, memory) {
  const normalizedCpu = normalizeResourceValue(cpu);
  const normalizedMemory = normalizeResourceValue(memory);
  if (!sessionCpuOptions.includes(normalizedCpu) || !sessionMemoryOptions.includes(normalizedMemory)) return false;
  const memoryGiB = parseMemoryGiB(normalizedMemory);
  const minMemory = Number(catalog.constraints?.minMemoryGiBByCpu?.[normalizedCpu] || 0);
  const maxMemory = Number(catalog.constraints?.maxMemoryGiBByCpu?.[normalizedCpu] || Infinity);
  return memoryGiB !== null && memoryGiB >= minMemory && memoryGiB <= maxMemory;
}

export function getSessionSizePreset(key) {
  return sessionSizePresets.find((preset) => preset.key === normalizeResourceValue(key)) || null;
}

export function inferSessionSize(cpu, memory) {
  const preset = sessionSizePresets.find((item) => item.cpu === cpu && item.memory === memory);
  return preset ? preset.key : "custom";
}

export function calculateEstimatedHourlyPrice(cpu, memory) {
  const cpuCount = Number(cpu);
  const memoryGiB = parseMemoryGiB(memory);
  if (!Number.isFinite(cpuCount) || cpuCount <= 0 || memoryGiB === null) return null;
  return Number(((cpuCount * Number(catalog.pricing.vcpuSecondUsd) + memoryGiB * Number(catalog.pricing.gibSecondUsd)) * 3600).toFixed(6));
}

export function calculateEstimatedUsageCost(usage = {}) {
  const cpuSeconds = Number(usage.cpuSeconds || 0);
  const memoryGiBSeconds = Number(usage.memoryGbSeconds || 0);
  return Number((cpuSeconds * Number(catalog.pricing.vcpuSecondUsd) + memoryGiBSeconds * Number(catalog.pricing.gibSecondUsd)).toFixed(6));
}

export function formatEstimatedHourlyPrice(cpu, memory) {
  const price = calculateEstimatedHourlyPrice(cpu, memory);
  return price === null ? "Price unavailable" : `$${price.toFixed(4)}/hr estimate`;
}

export function formatSessionMemory(value) {
  const normalized = normalizeResourceValue(value);
  return normalized.replace(/GiB?$/i, " GiB").replace(/Mi$/i, " MiB");
}

export function formatSessionSizeLabel(key) {
  if (key === "custom") return "Custom";
  return getSessionSizePreset(key)?.label || "Custom";
}

export function getDefaultSessionResources() {
  const preset = getSessionSizePreset("small");
  return preset ? {cpu: preset.cpu, memory: preset.memory} : {cpu: "1", memory: "2Gi"};
}

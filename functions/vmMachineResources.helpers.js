"use strict";

const {normalizeSessionResources, parseMemoryGiB} = require("./sessionResources.helpers");

/**
 * Convert the shared workspace resource catalog into an E2 custom machine type.
 * E2 custom shapes require even vCPU counts; the catalog's 1-vCPU shape uses
 * the E2 shared-core medium form instead.
 */
function vmMachineTypeForResources(resources) {
  if (resources == null) return null;
  const normalized = normalizeSessionResources(resources, {defaultResources: null});
  const cpu = Number(normalized.cpu);
  const memoryGiB = parseMemoryGiB(normalized.memory);
  const memoryMb = memoryGiB === null ? NaN : memoryGiB * 1024;
  if (!Number.isSafeInteger(cpu) || cpu < 1 || !Number.isSafeInteger(memoryMb) || memoryMb < 1024 || memoryMb % 256 !== 0) {
    const error = new Error("invalid_vm_machine_resources");
    error.code = "invalid_vm_machine_resources";
    throw error;
  }
  if (cpu === 1) return `e2-custom-medium-${memoryMb}`;
  if (cpu % 2 !== 0) {
    const error = new Error("invalid_vm_machine_cpu");
    error.code = "invalid_vm_machine_cpu";
    throw error;
  }
  return `e2-custom-${cpu}-${memoryMb}`;
}

module.exports = {vmMachineTypeForResources};

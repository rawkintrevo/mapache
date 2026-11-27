"use strict";

const {httpError} = require("./backendUtils.helpers");

const GIB = 1024 ** 3;
const HEADROOM = Object.freeze({vcpus: 1, memoryBytes: GIB, diskBytes: 5 * GIB});

function guestResources(resources = {cpu: "2", memory: "8Gi"}) {
  const cpu = resources?.cpu;
  const memory = resources?.memory;
  const match = typeof memory === "string" && /^([1-9]\d{0,2})Gi$/.exec(memory);
  if (!/^[1-9]\d?$/.test(cpu) || !["number", "string"].includes(typeof cpu) ||
      Number(cpu) > 64 || !match || Number(match[1]) > 256 ||
      Object.keys(resources).some((key) => !["cpu", "memory"].includes(key))) {
    throw httpError(400, "invalid_remote_vm_resources");
  }
  return {vcpus: Number(cpu), memoryMiB: Number(match[1]) * 1024, diskGiB: 40};
}

function workspaceResources({vcpus, memoryMiB}) {
  return {cpu: String(vcpus), memory: `${memoryMiB / 1024}Gi`};
}

function checkCapacity(host, guest, workspaceId) {
  const capacity = host.capacity || {};
  const reserved = host.remoteVmReservations || {};
  const owned = (reserved.entries || []).filter((entry) => workspaceId && entry.workspaceId === workspaceId);
  const required = {vcpus: guest.vcpus, memoryBytes: guest.memoryMiB * 1024 ** 2, diskBytes: guest.diskGiB * GIB};
  for (const [key, total] of Object.entries({vcpus: capacity.cpuCount, memoryBytes: capacity.memoryBytes, diskBytes: capacity.freeDiskBytes})) {
    if (!Number.isFinite(total) || total < 0) throw httpError(409, "remote_host_capacity_unavailable");
    const other = Number(reserved[key] || 0) - owned.reduce((sum, entry) => sum + entry[key], 0);
    if (total - other - required[key] < HEADROOM[key]) throw httpError(409, "remote_vm_capacity_exhausted");
  }
  return required;
}

module.exports = {guestResources, workspaceResources, checkCapacity, HEADROOM};

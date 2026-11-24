#!/usr/bin/env node
import {execFile} from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {promisify} from "node:util";

const run = promisify(execFile);
const MAX_INPUT_BYTES = 16 * 1024;
const SAFE_ID = /^[A-Za-z0-9_.-]{1,128}$/;
const SAFE_DISK = /^mapache-ws-[a-f0-9]{24}$/;

export function parseConfig(value) {
  const config = typeof value === "string" ? JSON.parse(value) : value;
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      config.projectId !== "pi-agents-cloud" || !SAFE_DISK.test(String(config.diskName || "")) ||
      !SAFE_ID.test(String(config.workspaceId || "")) || !SAFE_ID.test(String(config.ownerUid || "")) ||
      !Number.isSafeInteger(Number(config.generation)) || Number(config.generation) < 1 ||
      !/^[1-9][0-9]{0,19}$/.test(String(config.maintenanceId || "")) ||
      !/^[a-z][a-z0-9-]{0,62}$/.test(String(config.zone || "")) ||
      !Number.isSafeInteger(Number(config.expectedSizeGb)) || Number(config.expectedSizeGb) < 10 ||
      Number(config.expectedSizeGb) > 4096) {
    throw new Error("filesystem_growth_config_invalid");
  }
  return {...config, generation: Number(config.generation), expectedSizeGb: Number(config.expectedSizeGb)};
}

export function validateMarker(marker, config) {
  if (!marker || typeof marker !== "object" || Array.isArray(marker) ||
      marker.version !== 1 || marker.kind !== "retained-disk" ||
      marker.workspaceId !== config.workspaceId || marker.ownerUid !== config.ownerUid ||
      Number(marker.generation) !== config.generation) {
    throw new Error("filesystem_growth_marker_mismatch");
  }
}

export function filesystemProjection(stats, checkedAt = new Date().toISOString()) {
  const blockSize = safeInteger(stats?.bsize);
  const blocks = safeInteger(stats?.blocks);
  const freeBlocks = safeInteger(stats?.bfree);
  const availableBlocks = safeInteger(stats?.bavail);
  if (![blockSize, blocks, freeBlocks, availableBlocks].every(Number.isSafeInteger) ||
      blockSize <= 0 || blocks <= 0 || freeBlocks < 0 || availableBlocks < 0 ||
      freeBlocks > blocks || availableBlocks > blocks) {
    throw new Error("filesystem_growth_stats_invalid");
  }
  const capacityBytes = blockSize * blocks;
  const freeBytes = blockSize * freeBlocks;
  const availableBytes = blockSize * availableBlocks;
  if (![capacityBytes, freeBytes, availableBytes].every(Number.isSafeInteger) || capacityBytes <= 0) {
    throw new Error("filesystem_growth_stats_invalid");
  }
  return {
    type: "ext4",
    capacityBytes,
    usedBytes: capacityBytes - freeBytes,
    freeBytes,
    availableBytes,
    headroomPercent: Number(((availableBytes / capacityBytes) * 100).toFixed(2)),
    checkedAt,
  };
}

async function main() {
  const config = parseConfig(await readStdin());
  const instanceId = await metadata("instance/id");
  const projectId = await metadata("project/project-id");
  const zone = (await metadata("instance/zone")).split("/").at(-1);
  if (projectId !== config.projectId || zone !== config.zone || instanceId !== config.maintenanceId) {
    throw new Error("filesystem_growth_maintenance_identity_mismatch");
  }

  const device = `/dev/disk/by-id/google-${config.diskName}`;
  const diskBytes = positiveInteger(await commandOutput("blockdev", ["--getsize64", device]), "filesystem_growth_disk_size_invalid");
  if (diskBytes < config.expectedSizeGb * 1024 ** 3) throw new Error("filesystem_growth_provider_capacity_missing");
  const filesystemType = (await commandOutput("blkid", ["-o", "value", "-s", "TYPE", device])).trim();
  if (filesystemType !== "ext4") throw new Error("filesystem_growth_filesystem_type_invalid");
  const mounted = await findMount(device);
  if (mounted) throw new Error("filesystem_growth_disk_mounted");

  const fsckStartedAt = Date.now();
  await runFsck(device);
  const fsckMs = Date.now() - fsckStartedAt;
  const resizeStartedAt = Date.now();
  await run("resize2fs", [device], {timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024});
  const resizeMs = Date.now() - resizeStartedAt;

  const mountRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-grow-evidence-"));
  let mountedForEvidence = false;
  const verifyStartedAt = Date.now();
  try {
    await run("mount", ["-t", "ext4", "-o", "ro,noload", device, mountRoot], {timeout: 120000, maxBuffer: 64 * 1024});
    mountedForEvidence = true;
    const marker = JSON.parse(await fs.readFile(path.join(mountRoot, ".mapache-vm-disk.json"), "utf8"));
    validateMarker(marker, config);
    const filesystem = filesystemProjection(await fs.statfs(mountRoot, {bigint: true}));
    const verifyMs = Date.now() - verifyStartedAt;
    console.log(JSON.stringify({
      instanceId,
      diskName: config.diskName,
      providerCapacityBytes: diskBytes,
      filesystem,
      timingsMs: {fsck: fsckMs, resize: resizeMs, verify: verifyMs},
    }));
  } finally {
    if (mountedForEvidence) await run("umount", [mountRoot], {timeout: 120000, maxBuffer: 64 * 1024});
    await fs.rm(mountRoot, {recursive: true, force: true});
  }
}

async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES) throw new Error("filesystem_growth_config_invalid");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function metadata(key) {
  const response = await fetch(`http://metadata.google.internal/computeMetadata/v1/${key}`, {
    headers: {"Metadata-Flavor": "Google"}, redirect: "error", signal: AbortSignal.timeout(5000),
  });
  if (!response.ok || response.headers.get("Metadata-Flavor") !== "Google") {
    throw new Error("filesystem_growth_maintenance_identity_unavailable");
  }
  return (await response.text()).trim();
}

async function commandOutput(command, args) {
  const result = await run(command, args, {timeout: 120000, maxBuffer: 64 * 1024, encoding: "utf8"});
  return result.stdout;
}

async function findMount(device) {
  try {
    const output = await commandOutput("findmnt", ["-rn", "-S", device]);
    return output.trim().length > 0;
  } catch (error) {
    if (error?.code === 1) return false;
    throw new Error("filesystem_growth_mount_probe_failed");
  }
}

async function runFsck(device) {
  try {
    await run("e2fsck", ["-pf", device], {timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024});
  } catch (error) {
    if (error?.code !== 1) throw new Error("filesystem_growth_fsck_failed");
  }
}

function safeInteger(value) {
  if (typeof value === "bigint") return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  return Number.isSafeInteger(value) ? value : null;
}

function positiveInteger(value, errorCode) {
  const number = Number(String(value).trim());
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(errorCode);
  return number;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    const reason = /^(?:filesystem_growth_)[a-z_]+$/.test(String(error?.message || "")) ? error.message : "filesystem_growth_failed";
    process.stderr.write(`${JSON.stringify({error: reason})}\n`);
    process.exitCode = 1;
  });
}

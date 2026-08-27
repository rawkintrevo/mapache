"use strict";

const fs = require("fs");
const path = require("path");
const {parsePiChatEntry} = require("./piChatTranscript");

const MAX_REPLAY_MESSAGES = 200;
const MAX_REPLAY_BYTES = 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 250;

/**
 * Watch the active Pi transcript and publish only the safe Chat contract.
 * Filesystem and timer dependencies are kept injectable so this service can
 * be tested without a runner, network, or real Pi process.
 */
function createPiChatTranscriptService(options = {}) {
  const fileSystem = options.fs || fs;
  const timers = options.timers || globalThis;
  const parse = options.parse || parsePiChatEntry;
  const pollIntervalMs = positiveNumber(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  const sessionDir = String(options.config?.piSessionDir || options.piSessionDir || "").trim();
  const explicitPath = String(options.config?.piSessionJsonlPath || options.piSessionJsonlPath || "").trim();
  const listeners = new Set();
  const state = {
    activeBranchIds: new Set(),
    file: null,
    messages: [],
    pendingLine: "",
    records: [],
    source: "",
    status: "waiting_for_transcript",
    emittedIds: new Set(),
  };
  let pollTimer = null;
  let polling = false;
  let inFlight = null;
  let stopped = true;

  return {
    subscribe,
    unsubscribe(listener) {
      listeners.delete(listener);
      stopIfUnused();
    },
    poll,
    refresh: poll,
    start,
    stop,
    shutdown: stop,
    getSnapshot() {
      return state.messages.slice();
    },
    getStatus() {
      return state.status;
    },
  };

  function subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("Pi Chat subscriber must be a function");
    listeners.add(listener);
    if (listeners.size === 1) start();
    if (state.status === "waiting_for_transcript") {
      notify(listener, {type: "status", status: state.status});
    } else {
      notify(listener, {type: state.file?.initialized ? "snapshot" : "reset", messages: state.messages.slice()});
    }
    return () => {
      listeners.delete(listener);
      stopIfUnused();
    };
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    schedulePoll(0);
  }

  function stop() {
    stopped = true;
    if (pollTimer !== null) timers.clearTimeout(pollTimer);
    pollTimer = null;
  }

  function stopIfUnused() {
    if (listeners.size === 0) stop();
  }

  function schedulePoll(delay) {
    if (stopped || listeners.size === 0 || pollTimer !== null) return;
    pollTimer = timers.setTimeout(() => {
      pollTimer = null;
      void poll();
    }, delay);
    if (typeof pollTimer?.unref === "function") pollTimer.unref();
  }

  function poll() {
    if (polling) return inFlight || Promise.resolve();
    if (stopped || listeners.size === 0) return Promise.resolve();
    polling = true;
    inFlight = (async () => {
      try {
      const latest = await findLatestTranscript();
      if (!latest) {
        if (state.status !== "waiting_for_transcript") {
          state.status = "waiting_for_transcript";
          state.file = null;
          state.records = [];
          state.messages = [];
          state.pendingLine = "";
          state.source = "";
          state.activeBranchIds = new Set();
          notifyAll({type: "status", status: state.status});
        } else if (!state.file) {
          notifyAll({type: "status", status: state.status});
        }
        return;
      }

      const source = await readSource(latest.path);
      const identityChanged = hasNewFile(latest) || isTruncated(source);
      if (identityChanged || !state.file) {
        rebuild(latest, source, identityChanged && Boolean(state.file));
      } else if (source !== state.source) {
        append(latest, source);
      }
      if (state.status !== "ready") {
        state.status = "ready";
        notifyAll({type: "status", status: state.status});
      }
      } catch (error) {
      // Transcript errors are intentionally private. The public contract only
      // reports that Pi is still waiting for a usable transcript.
      if (state.status !== "waiting_for_transcript") {
        state.status = "waiting_for_transcript";
        notifyAll({type: "status", status: state.status});
      }
      } finally {
        polling = false;
        inFlight = null;
        schedulePoll(pollIntervalMs);
      }
    })();
    return inFlight;
  }

  async function findLatestTranscript() {
    if (explicitPath) {
      try {
        const stat = await fileSystem.promises.stat(explicitPath);
        if (stat.isFile() && explicitPath.endsWith(".jsonl")) return fileInfo(explicitPath, stat);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    if (!sessionDir) return null;
    const files = await findJsonlFiles(sessionDir);
    return files.sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path))[0] || null;
  }

  async function findJsonlFiles(directory) {
    let entries;
    try {
      entries = await fileSystem.promises.readdir(directory, {withFileTypes: true});
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const nested = await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return findJsonlFiles(entryPath);
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) return [];
      const stat = await fileSystem.promises.stat(entryPath);
      return [fileInfo(entryPath, stat)];
    }));
    return nested.flat();
  }

  async function readSource(filePath) {
    const value = await fileSystem.promises.readFile(filePath, "utf8");
    return Buffer.isBuffer(value) ? value.toString("utf8") : String(value || "");
  }

  function rebuild(fileInfoValue, source, shouldReset) {
    const replaySource = limitReplaySource(source);
    const parsed = parseLines(replaySource);
    state.file = {...fileInfoValue, initialized: true};
    state.source = source;
    state.pendingLine = parsed.pendingLine;
    state.records = parsed.records;
    const active = activeBranch(parsed.records);
    const messages = boundedMessages(active.messages);
    state.activeBranchIds = active.ids;
    state.messages = messages;
    markMessageIds(messages, state);
    notifyAll({type: shouldReset ? "reset" : "snapshot", messages: messages.slice()});
  }

  function append(fileInfoValue, source) {
    if (!source.startsWith(state.source)) {
      rebuild(fileInfoValue, source, true);
      return;
    }

    const appended = state.pendingLine + source.slice(state.source.length);
    const parsed = parseLines(appended);
    state.file = {...fileInfoValue, initialized: true};
    state.source = source;
    state.pendingLine = parsed.pendingLine;
    if (!parsed.records.length) return;

    const previousBranchIds = state.activeBranchIds;
    state.records = dedupeRecords([...state.records, ...parsed.records]);
    const active = activeBranch(state.records);
    const nextMessages = boundedMessages(active.messages);
    const branchExtended = containsAll(active.ids, previousBranchIds);
    state.activeBranchIds = active.ids;
    state.messages = nextMessages;

    if (!branchExtended) {
      markMessageIds(nextMessages, state);
      notifyAll({type: "reset", messages: nextMessages.slice()});
      return;
    }

    const newMessages = nextMessages.filter((message) => !state.emittedIds.has(message.id));
    markMessageIds(newMessages, state);
    for (const message of newMessages) notifyAll({type: "message", message});
  }

  function parseLines(source) {
    const lastNewline = source.lastIndexOf("\n");
    const complete = lastNewline >= 0 ? source.slice(0, lastNewline) : "";
    const pendingLine = lastNewline >= 0 ? source.slice(lastNewline + 1) : source;
    const records = [];
    for (const rawLine of complete.split("\n")) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      const record = parseRecord(line);
      if (record) records.push(record);
    }
    return {pendingLine, records: dedupeRecords(records)};
  }

  function parseRecord(line) {
    if (!line) return null;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      return null;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const id = stableId(raw);
    const message = parse(raw);
    if (!id && !message) return null;
    return {
      id: id || message?.id || "",
      parentId: stableParentId(raw),
      message,
    };
  }

  function activeBranch(records) {
    const byId = new Map();
    for (const record of records) if (record.id) byId.set(record.id, record);
    const tip = records.slice().reverse().find((record) => record.id);
    const ids = new Set();
    let current = tip;
    while (current && current.id && !ids.has(current.id)) {
      ids.add(current.id);
      current = byId.get(current.parentId);
    }
    const messages = records
        .filter((record) => record.message && ids.has(record.id))
        .map((record) => record.message);
    return {ids, messages: uniqueMessages(messages)};
  }

  function boundedMessages(messages) {
    return messages.length > MAX_REPLAY_MESSAGES ? messages.slice(-MAX_REPLAY_MESSAGES) : messages.slice();
  }

  function limitReplaySource(source) {
    if (Buffer.byteLength(source, "utf8") <= MAX_REPLAY_BYTES) return source;
    const bytes = Buffer.from(source, "utf8");
    return bytes.subarray(bytes.length - MAX_REPLAY_BYTES).toString("utf8");
  }

  function hasNewFile(fileInfoValue) {
    if (!state.file) return true;
    return state.file.path !== fileInfoValue.path || state.file.ino !== fileInfoValue.ino ||
      (state.file.mtimeMs !== fileInfoValue.mtimeMs && fileInfoValue.size === state.file.size);
  }

  function isTruncated(source) {
    return Boolean(state.file && source.length < state.source.length);
  }

  function notifyAll(event) {
    for (const listener of listeners) notify(listener, event);
  }

  function notify(listener, event) {
    try {
      listener(event);
    } catch (error) {
      // A bad subscriber must not stop transcript delivery to other clients.
    }
  }
}

function markMessageIds(messages, state) {
  for (const message of messages) state.emittedIds.add(message.id);
}

function uniqueMessages(messages) {
  const seen = new Set();
  return messages.filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

function dedupeRecords(records) {
  const seen = new Set();
  return records.filter((record) => {
    if (!record.id) return true;
    if (seen.has(record.id)) return false;
    seen.add(record.id);
    return true;
  });
}

function containsAll(haystack, needles) {
  for (const value of needles) if (!haystack.has(value)) return false;
  return true;
}

function stableId(entry) {
  const value = entry.id ?? entry.entryId;
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function stableParentId(entry) {
  const value = entry.parentId;
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function fileInfo(filePath, stat) {
  return {
    path: filePath,
    ino: stat.ino || 0,
    mtimeMs: Number(stat.mtimeMs || 0),
    size: Number(stat.size || 0),
  };
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

module.exports = {
  DEFAULT_POLL_INTERVAL_MS,
  MAX_REPLAY_BYTES,
  MAX_REPLAY_MESSAGES,
  createPiChatService: createPiChatTranscriptService,
  createPiChatTranscriptService,
};

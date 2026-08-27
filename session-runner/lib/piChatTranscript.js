"use strict";

/**
 * Normalize one Pi session entry into the intentionally small Chat contract.
 *
 * This module is deliberately pure: callers own JSONL parsing, file access,
 * replay limits, and transport concerns.
 *
 * @param {object|string} entryOrLine A parsed Pi entry or one JSONL line.
 * @returns {{id: string, role: "user"|"assistant", markdown: string, createdAt: string|null}|null}
 */
function parsePiChatEntry(entryOrLine) {
  const entry = parseEntry(entryOrLine);
  if (!entry || entry.type !== "message") return null;

  const message = entry.message;
  if (!message || (message.role !== "user" && message.role !== "assistant")) return null;

  const id = stableEntryId(entry);
  if (!id) return null;

  const markdown = displayText(message.content);
  if (!markdown || markdown.trim().length === 0) return null;

  return {
    id,
    role: message.role,
    markdown,
    createdAt: timestamp(entry, message),
  };
}

function parseEntry(entryOrLine) {
  if (entryOrLine && typeof entryOrLine === "object" && !Array.isArray(entryOrLine)) {
    return entryOrLine;
  }
  if (typeof entryOrLine !== "string") return null;
  try {
    const parsed = JSON.parse(entryOrLine);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    return null;
  }
}

function stableEntryId(entry) {
  const value = entry.id ?? entry.entryId;
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).trim();
}

function displayText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
      .filter((block) => block && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
}

function timestamp(entry, message) {
  const value = entry.timestamp ?? entry.createdAt ?? message.timestamp ?? null;
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : String(value);
}

module.exports = {
  parsePiChatEntry,
};

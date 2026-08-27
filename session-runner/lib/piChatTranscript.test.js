"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {parsePiChatEntry} = require("./piChatTranscript");

const markdownFixture = `# Release notes

- **Fast** response
- [Docs](https://example.com/docs)
- [x] shipped

> Keep the terminal available.

\`inline()\`

\`\`\`js
console.log("hello");
\`\`\`

| Name | Value |
| --- | --- |
| Chat | MVP |
`;

test("normalizes a user message with string content", () => {
  assert.deepEqual(parsePiChatEntry({
    type: "message",
    id: "user-1",
    timestamp: "2026-08-27T14:00:00.000Z",
    message: {role: "user", content: "hello Pi"},
  }), {
    id: "user-1",
    role: "user",
    markdown: "hello Pi",
    createdAt: "2026-08-27T14:00:00.000Z",
  });
});

test("concatenates only ordered text blocks", () => {
  assert.deepEqual(parsePiChatEntry({
    type: "message",
    id: "user-2",
    message: {
      role: "user",
      content: [
        {type: "text", text: "one"},
        {type: "thinking", thinking: "hidden"},
        {type: "toolCall", name: "hidden"},
        {type: "text", text: "\ntwo"},
      ],
    },
  }), {
    id: "user-2",
    role: "user",
    markdown: "one\ntwo",
    createdAt: null,
  });
});

test("preserves assistant Markdown byte-for-byte", () => {
  assert.deepEqual(parsePiChatEntry(JSON.stringify({
    type: "message",
    id: "assistant-1",
    timestamp: 1724767200000,
    message: {role: "assistant", content: markdownFixture},
  })), {
    id: "assistant-1",
    role: "assistant",
    markdown: markdownFixture,
    createdAt: "1724767200000",
  });
});

test("ignores unsupported entries and malformed or incomplete JSONL", () => {
  const ignored = [
    {type: "thinking", id: "thinking-1", message: {role: "assistant", content: "secret"}},
    {type: "message", id: "tool-1", message: {role: "toolResult", content: "secret"}},
    {type: "custom", id: "custom-1", content: "not a message"},
    {type: "message", id: "system-1", message: {role: "system", content: "not shown"}},
    {type: "message", id: "blank-1", message: {role: "assistant", content: "  \n"}},
  ];
  for (const entry of ignored) assert.equal(parsePiChatEntry(entry), null);
  assert.equal(parsePiChatEntry("not json"), null);
  assert.equal(parsePiChatEntry('{"type":"message","id":"partial"'), null);
});

test("rejects messages without a stable id or displayable text", () => {
  assert.equal(parsePiChatEntry({type: "message", message: {role: "user", content: "hello"}}), null);
  assert.equal(parsePiChatEntry({
    type: "message",
    id: "empty-blocks",
    message: {role: "assistant", content: [{type: "text", text: ""}]},
  }), null);
  assert.equal(parsePiChatEntry({
    type: "message",
    id: "no-text-blocks",
    message: {role: "assistant", content: [{type: "image", source: "private"}]},
  }), null);
});

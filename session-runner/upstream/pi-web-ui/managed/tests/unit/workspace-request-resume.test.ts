import assert from "node:assert/strict";
import {test} from "vitest";
import {shouldResumeInterruptedWorkspaceRequest} from "../../server/workspace-request-resume.js";

test("resumes a persisted ask with its stable idempotency key", () => {
	assert.equal(shouldResumeInterruptedWorkspaceRequest([
		{role: "user", content: "Ask Research"},
		{role: "assistant", content: [{type: "toolCall", name: "mcp", arguments: {
			tool: "workspace_request_ask",
			args: {targetWorkspaceId: "research", idempotencyKey: "research-1"},
		}}]},
		{role: "toolResult", content: "runner stopped"},
	]), true);
});

test("does not resume unrelated or incomplete request calls", () => {
	assert.equal(shouldResumeInterruptedWorkspaceRequest([
		{role: "user", content: "List targets"},
		{role: "assistant", content: [{type: "toolCall", name: "workspace_request_targets"}]},
	]), false);
	assert.equal(shouldResumeInterruptedWorkspaceRequest([
		{role: "user", content: "Ask Research"},
		{role: "assistant", content: [{type: "toolCall", name: "workspace_request_ask"}]},
	]), false);
	assert.equal(shouldResumeInterruptedWorkspaceRequest([
		{role: "user", content: "Explain the implementation"},
		{role: "assistant", content: "workspace_request_ask requires idempotencyKey"},
	]), false);
});

test("does not cross into an earlier user turn", () => {
	assert.equal(shouldResumeInterruptedWorkspaceRequest([
		{role: "assistant", content: "workspace_request_ask idempotencyKey"},
		{role: "user", content: "Do something else"},
		{role: "assistant", content: "interrupted"},
	]), false);
});

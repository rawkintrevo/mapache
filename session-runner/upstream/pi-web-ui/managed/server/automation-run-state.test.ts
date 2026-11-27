import assert from "node:assert/strict";
import {test} from "vitest";
import {
	createAutomationRunState,
	isAutomationRunTerminal,
	reduceAutomationRunState,
	type AutomationRunEvent,
} from "./automation-run-state.js";

function apply(state: ReturnType<typeof createAutomationRunState>, ...events: AutomationRunEvent[]) {
	return events.reduce(reduceAutomationRunState, state);
}

function event(type: AutomationRunEvent["type"], fields: Record<string, unknown> = {}): AutomationRunEvent {
	return {type, runId: "run-1", conversationId: "conversation-1", ...fields} as AutomationRunEvent;
}

test("requires final non-retry agent end and drains tools, subagents, and background tasks", () => {
	let state = apply(
		createAutomationRunState("run-1"),
		event("started"),
		event("tool_start", {taskId: "tool-1"}),
		event("subagent_start", {taskId: "subagent-1"}),
		event("background_task_start", {taskId: "background-1"}),
		event("agent_end", {result: "success"}),
	);
	assert.equal(state.agentEnded, true);
	assert.equal(state.terminal, null);
	state = apply(
		state,
		event("tool_end", {taskId: "tool-1", isError: true}),
		event("subagent_end", {taskId: "subagent-1"}),
		event("background_task_end", {taskId: "background-1"}),
	);
	assert.equal(state.terminal, "succeeded");
	assert.equal(isAutomationRunTerminal(state), true);
});

test("duplicate task and event IDs are idempotent", () => {
	let state = apply(
		createAutomationRunState("run-1"),
		event("started", {eventId: "start-1"}),
		event("started", {eventId: "start-1"}),
		event("tool_start", {taskId: "tool-1", eventId: "tool-start-1"}),
		event("tool_start", {taskId: "tool-1", eventId: "tool-start-2"}),
	);
	assert.deepEqual(state.toolIds, ["tool-1"]);
	state = apply(state, event("tool_end", {taskId: "tool-1", eventId: "tool-end-1"}), event("tool_end", {taskId: "tool-1", eventId: "tool-end-1"}));
	assert.deepEqual(state.toolIds, []);
});

test("wrong run or conversation cannot affect state", () => {
	let state = apply(createAutomationRunState("run-1"), event("started"));
	const wrongRun = {...event("agent_end", {result: "success"}), runId: "run-2"} as AutomationRunEvent;
	const wrongConversation = {...event("agent_end", {result: "success"}), conversationId: "conversation-2"} as AutomationRunEvent;
	state = reduceAutomationRunState(state, wrongRun);
	state = reduceAutomationRunState(state, wrongConversation);
	assert.equal(state.agentEnded, false);
	assert.equal(state.terminal, null);
});

test("retrying agent end is not final, while a model error is terminal only when final", () => {
	let state = apply(
		createAutomationRunState("run-1"),
		event("started"),
		event("agent_end", {result: "error", error: "temporary", willRetry: true}),
	);
	assert.equal(state.agentEnded, false);
	assert.equal(state.terminal, null);
	state = apply(state, event("model_end", {error: "provider down", retryable: false}), event("agent_end", {result: "error", error: "provider down"}));
	assert.equal(state.terminal, "failed");
});

test("tool failures do not fail a final successful agent result", () => {
	const state = apply(
		createAutomationRunState("run-1"),
		event("started"),
		event("tool_start", {taskId: "tool-1"}),
		event("tool_end", {taskId: "tool-1", isError: true, error: "recoverable"}),
		event("agent_end", {result: "success"}),
	);
	assert.equal(state.finalError, null);
	assert.equal(state.terminal, "succeeded");
});

test("input request becomes interaction_required, but cancellation wins before terminal commit", () => {
	let state = apply(createAutomationRunState("run-1"), event("started"), event("input_requested", {requestId: "question-1"}));
	assert.equal(state.interactionRequired, true);
	assert.equal(state.terminal, null);
	state = reduceAutomationRunState(state, event("canceled", {error: "runner stopped"}));
	assert.equal(state.terminal, "canceled");

	state = apply(createAutomationRunState("run-1"), event("started"), event("input_requested", {requestId: "question-1"}), event("agent_end", {result: "success"}));
	assert.equal(state.terminal, "interaction_required");
});

test("stores a bounded final assistant answer without exposing a failed answer", () => {
	const answer = "Workspace purpose: social media planning.";
	const success = apply(
		createAutomationRunState("run-1"),
		event("started"),
		event("agent_end", {result: "success", answer}),
	);
	assert.equal(success.finalAnswer, answer);
	assert.equal(success.terminal, "succeeded");

	const failed = apply(
		createAutomationRunState("run-1"),
		event("started"),
		event("agent_end", {result: "error", error: "provider failed", answer}),
	);
	assert.equal(failed.finalAnswer, null);

	const bounded = apply(
		createAutomationRunState("run-1"),
		event("started"),
		event("agent_end", {result: "success", answer: "x".repeat(40000)}),
	);
	assert.equal(bounded.finalAnswer?.length, 32768);
});

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientStateStore, type ConversationGoalState } from "../../server/client-state.js";
import { GoalService, type GoalConversation, type GoalHost } from "../../server/goal-service.js";
import type { ServerMessage } from "../../server/protocol.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeSavedGoal(): ConversationGoalState {
	return {
		goal: "Keep the native goal attached to this conversation",
		reviewModel: "openai/gpt-5",
		maxRounds: 3,
		locked: false,
		round: 2,
		verdict: "fail",
		status: "Needs one more pass",
		statusEn: "Needs one more pass",
		feedback: "Preserve the conversation identity.",
		materials: ["docs/spec.md", "/workspace/reference.png"],
		savedAt: 123,
	};
}

function makeHarness(filePath: string, sessionId: string, clientId: string) {
	const sent: string[] = [];
	const session = {
		sessionId,
		sessionFile: `/var/lib/pi/sessions/${sessionId}.jsonl`,
		isStreaming: false,
		sendUserMessage: vi.fn(async (message: string) => {
			sent.push(message);
		}),
	} as unknown as AgentSession;
	const conv = {
		id: "c1",
		cwd: "/workspace",
		session,
		wizardRunning: false,
		goalGeneration: 0,
		goalReviewGeneration: 0,
		goal: undefined,
	} as unknown as GoalConversation;
	const emitted: ServerMessage[] = [];
	const flushSnapshot = vi.fn();
	const host = {
		clientId,
		agentDir: "/tmp/agent",
		stateStore: new ClientStateStore(filePath),
		webUi: { cancelPendingDialogs: vi.fn() },
		emit: (msg: ServerMessage) => emitted.push(msg),
		flushSnapshot,
		isDisposed: () => false,
		quiesced: () => false,
		quiesceBlocked: () => false,
		activeConvId: () => conv.id,
		activeConv: () => conv,
		getConv: (id: string) => (id === conv.id ? conv : undefined),
		conversations: () => [conv],
		cwd: () => conv.cwd,
		reviewSettings: () => ({ reviewPrompt: "", reviewDisabledSkills: [] }),
		gitDiff: async () => "",
		goalModeEnabled: () => true,
		spawnRoleAgent: vi.fn(),
		waitRoleAgent: vi.fn(),
		sendRoleAgent: vi.fn(),
		readRoleAgent: vi.fn(),
		hasConv: () => true,
	} as unknown as GoalHost;
	const service = new GoalService(host);
	conv.goal = service.makeGoalStatus();
	return { conv, emitted, flushSnapshot, host, sent, service };
}

describe("native Goal persistence", () => {
	it("stores display state in the global client-state entry and restores it for a new browser client", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-web-ui-goal-persistence-"));
		tempDirs.push(dir);
		const filePath = join(dir, "client-state.json");
		const saved = makeSavedGoal();
		new ClientStateStore(filePath).saveConversationGoal("session:stable-1", saved);

		const reloaded = new ClientStateStore(filePath);
		expect(reloaded.getConversationGoal("session:stable-1")).toEqual(saved);
		expect(reloaded.getConversationGoal("session:other")).toBeUndefined();
		const disk = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
		expect(disk.__settings__).toMatchObject({ conversationGoals: { "session:stable-1": saved } });
	});

	it("restores a goal paused without starting review work, then resumes only on explicit action", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-web-ui-goal-restore-"));
		tempDirs.push(dir);
		const filePath = join(dir, "client-state.json");
		new ClientStateStore(filePath).saveConversationGoal("session:stable-1", makeSavedGoal());

		const { conv, flushSnapshot, sent, service } = makeHarness(filePath, "stable-1", "fresh-browser-client");
		service.restoreGoalStatus(conv);
		expect(conv.goal.materials).toEqual(["docs/spec.md", "/workspace/reference.png"]);

		expect(conv.goal).toMatchObject({
			conversationId: "c1",
			goal: "Keep the native goal attached to this conversation",
			reviewModel: "openai/gpt-5",
			maxRounds: 3,
			locked: false,
			round: 2,
			verdict: "fail",
			paused: true,
			reviewing: false,
			wizard: { active: false, draft: "", step: 0 },
		});

		// Reconnect/history open must not kick the model or start the reviewer.
		expect(service.onAgentEnd(conv, false)).toBeNull();
		expect(sent).toHaveLength(0);

		const start = vi.spyOn(service, "setGoal").mockResolvedValue(undefined);
		await service.resumeGoal();
		expect(conv.goal.paused).toBe(false);
		expect(start).toHaveBeenCalledWith("Keep the native goal attached to this conversation", expect.objectContaining({targetConvId: "c1", reviewModel: "openai/gpt-5", maxRounds: 3}));
		expect(sent).toHaveLength(0);
	});

	it("keeps restored state scoped to the stable upstream session identity", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-web-ui-goal-scope-"));
		tempDirs.push(dir);
		const filePath = join(dir, "client-state.json");
		new ClientStateStore(filePath).saveConversationGoal("session:stable-1", makeSavedGoal());

		const first = makeHarness(filePath, "stable-1", "client-a");
		const second = makeHarness(filePath, "stable-2", "client-b");
		first.service.restoreGoalStatus(first.conv);
		second.service.restoreGoalStatus(second.conv);

		expect(first.conv.goal.goal).toBe("Keep the native goal attached to this conversation");
		expect(second.conv.goal.goal).toBeNull();
		expect(second.conv.goal.paused).toBe(false);
	});

	it("pauses a native goal and invalidates review work during quiesce", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-web-ui-goal-quiesce-"));
		tempDirs.push(dir);
		const harness = makeHarness(join(dir, "client-state.json"), "stable-1", "client-a");
		await harness.service.setGoal("Finish the drain-safe goal", { autoStart: false });

		await harness.service.quiesce();

		expect(harness.conv.goal).toMatchObject({
			goal: "Finish the drain-safe goal",
			paused: true,
			reviewing: false,
			statusEn: "Goal paused while the server is stopping…",
		});
		expect(harness.conv.goalGeneration).toBe(2);
	});
});

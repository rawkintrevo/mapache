import type { ConversationGoalState } from "../packages/keel/src/projects-schema.js";
import type { GoalRunSinks } from "../packages/keel/src/domains/goals/index.js";
import { createGoalRun, type GoalRun } from "./goal-run-state.js";

export interface GoalDisplayStore {
	getConversationGoal?(identity: string): ConversationGoalState | undefined;
	saveConversationGoal?(identity: string, goal: ConversationGoalState): void;
	deleteConversationGoal?(identity: string): void;
}

/** Persist only display state under the same stable identity as the older managed runtime. */
export function createManagedGoalState(sinks: GoalRunSinks, store: GoalDisplayStore) {
	const identity = (parentId: string) => sinks.conversationIdentity?.(parentId);
	const forget = (parentId: string): void => {
		const key = identity(parentId);
		if (key) store.deleteConversationGoal?.(key);
	};
	return {
		forget,
		persist(run: GoalRun): void {
			const key = identity(run.parentId);
			if (!key || run.phase === "wizard" || !run.goal.trim()) return;
			if (run.phase === "pass") { forget(run.parentId); return; }
			store.saveConversationGoal?.(key, {
				goal: run.goal, materials: run.materials, execModel: run.execModel,
				reviewModel: run.reviewModel, maxRounds: run.maxRounds, locked: run.locked,
				round: run.round, verdict: run.verdict, status: run.status, statusEn: run.statusEn,
				feedback: run.feedback, savedAt: Date.now(),
			});
		},
		restore(parentId: string): GoalRun | undefined {
			const key = identity(parentId);
			const saved = key ? store.getConversationGoal?.(key) : undefined;
			if (!saved) return;
			const run = createGoalRun({
				parentId, cwd: sinks.conversationCwd(parentId) ?? sinks.cwd(), goal: saved.goal,
				generation: 1, phase: "idle", prefs: saved, materials: saved.materials,
				status: saved.status, statusEn: saved.statusEn ?? "",
			});
			run.round = saved.round; run.verdict = saved.verdict; run.feedback = saved.feedback ?? "";
			run.paused = true; run.stopped = true;
			return run;
		},
	};
}

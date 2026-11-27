import type { GoalRunPort, GoalStartOptions } from "../packages/keel/src/contracts/goals.js";
import type { GoalRunSinks } from "../packages/keel/src/domains/goals/index.js";
import type { GoalRun } from "./goal-run-state.js";

/** Display restore never starts work; only explicit resume may replace a paused run. */
export function managedGoalLifecycle(input: {
	sinks: GoalRunSinks;
	runs: Map<string, GoalRun>;
	persist(run: GoalRun): void;
	restore(parentId: string): GoalRun | undefined;
	publish(run?: GoalRun): void;
	closeAll(run: GoalRun): void;
	quiescing(): boolean;
	setQuiescing(value: boolean): void;
	goalModeOn(): boolean;
	commitGoal(parentId: string, text: string, opts?: GoalStartOptions): Promise<void>;
}): Pick<GoalRunPort, "restoreGoal" | "resumeGoal" | "quiesce" | "unquiesce"> {
	let drained = false;
	return {
		restoreGoal(parentId) {
			const run = input.runs.get(parentId) ?? input.restore(parentId);
			if (run) input.runs.set(parentId, run);
			input.publish(run);
		},
		async resumeGoal() {
			if (input.quiescing() || input.sinks.isDisposed() || !input.goalModeOn()) return;
			const parentId = input.sinks.activeConversationId();
			const run = parentId ? input.runs.get(parentId) : undefined;
			if (!run?.paused || !run.goal.trim()) return;
			// Claim synchronously so repeated clicks cannot start duplicate execution.
			run.paused = false;
			try {
				await input.commitGoal(run.parentId, run.goal, {
					reviewModel: run.reviewModel,
					execModel: run.execModel,
					maxRounds: run.maxRounds,
					locked: run.locked,
					materials: [...(run.materials ?? [])],
				});
			} catch (error) {
				if (input.runs.get(run.parentId) === run) {
					run.paused = true;
					input.publish(run);
				}
				throw error;
			}
		},
		async quiesce() {
			input.setQuiescing(true);
			drained = false;
			const active = [...input.runs.values()];
			for (const run of active) {
				input.persist(run);
				run.paused = true;
				run.stopped = true;
				run.generation += 1;
			}
			await Promise.all(
				active.flatMap((run) =>
					[run.execId, run.reviewId, run.wizardId]
						.filter((id): id is string => !!id)
						.map((id) => input.sinks.abortTurn(id)),
				),
			);
			for (const run of active) {
				input.closeAll(run);
				if (run.phase === "wizard") {
					input.runs.delete(run.parentId);
					continue;
				}
				run.phase = "idle";
				input.publish(run);
			}
			drained = true;
		},
		unquiesce() {
			if (input.quiescing() && !drained) throw new Error("goal_drain_not_complete");
			input.setQuiescing(false);
		},
	};
}

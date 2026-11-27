import { describe, expect, it, vi } from "vitest";
import { handlePlanAndGoalMessage } from "../../server/dispatch-domain-handlers.js";
import type { DispatchSession } from "../../server/engine-service.js";

describe("managed goal resume wire", () => {
	it("dispatches explicit resume and reports asynchronous failure", async () => {
		const resumeGoal = vi.fn(async () => {
			throw new Error("private internal detail");
		});
		const emitNotice = vi.fn();
		const session = { resumeGoal, emitNotice } as unknown as DispatchSession;
		expect(handlePlanAndGoalMessage({ type: "resume_goal" }, session)).toBe(true);
		await vi.waitFor(() => expect(emitNotice).toHaveBeenCalledOnce());
		expect(resumeGoal).toHaveBeenCalledOnce();
		expect(JSON.stringify(emitNotice.mock.calls)).not.toContain("private internal detail");
	});
	it("rejects unsupported runtime resume instead of silently accepting it", () => {
		expect(() => handlePlanAndGoalMessage({ type: "resume_goal" }, {} as DispatchSession)).toThrow(
			"goal_resume_unsupported",
		);
	});
});

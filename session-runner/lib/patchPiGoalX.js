"use strict";

const fs = require("fs");
const path = require("path");

const RPC_BRANCH = `\tif (ctx.mode === "rpc") {\n\t\tconst confirmed = await ctx.ui.confirm("Confirm task list", proposalText);\n\t\treturn { decision: confirmed ? "confirm" : "cancel" };\n\t}\n`;

/**
 * Make pi-goal-x's task confirmation usable by the JSON RPC client. The
 * package's terminal-only custom dialog is intentionally retained for TUI
 * sessions; RPC has a first-class confirm dialog that the Web UI can answer.
 */
function patchPiGoalX({agentDir = process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME || "/root", ".pi", "agent"), fsModule = fs} = {}) {
  const target = path.join(agentDir, "npm", "node_modules", "pi-goal-x", "extensions", "goal-task-confirmation.ts");
  let source;
  try {
    source = fsModule.readFileSync(target, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {patched: false, reason: "managed_package_missing", target};
    throw error;
  }
  if (source.includes('ctx.mode === "rpc"')) return {patched: false, reason: "already_patched", target};
  const marker = "\tconst autoConfirmEnv = process.env.PI_GOAL_AUTO_CONFIRM;";
  if (!source.includes(marker)) return {patched: false, reason: "patch_marker_missing", target};
  fsModule.writeFileSync(target, source.replace(marker, `${RPC_BRANCH}${marker}`), "utf8");
  return {patched: true, target};
}

if (require.main === module) {
  const result = patchPiGoalX();
  if (result.reason === "managed_package_missing") {
    console.warn(`pi-goal-x patch skipped: ${result.target}`);
  } else if (result.reason === "patch_marker_missing") {
    throw new Error("pi_goal_x_patch_marker_missing");
  }
}

module.exports = {patchPiGoalX};

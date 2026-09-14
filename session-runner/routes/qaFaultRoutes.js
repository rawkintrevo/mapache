"use strict";

/**
 * Runner-internal bridge for the disposable hosted lifecycle case. The
 * Functions API is the only caller in normal use and authenticates with the
 * per-session shutdown token before this route is reached.
 */
function registerQaFaultRoutes({app, faultHarness, hasRunnerAccess}) {
  app.get("/qa/faults/status", requireRunnerAccess(hasRunnerAccess), async (_req, res) => {
    if (!faultHarness?.enabled?.()) {
      res.status(404).json({error: "not_found"});
      return;
    }
    try {
      res.json(await faultHarness.status());
    } catch (error) {
      res.status(error.status || 409).json({error: error.code || "qa_fault_status_failed"});
    }
  });

  app.post("/qa/faults", requireRunnerAccess(hasRunnerAccess), async (req, res) => {
    if (!faultHarness?.enabled?.()) {
      res.status(404).json({error: "not_found"});
      return;
    }
    try {
      const body = req.body || {};
      const action = String(body.action || "arm").trim().toLowerCase();
      if (action === "arm") {
        res.json(await faultHarness.arm(body.fault, body));
        return;
      }
      if (action === "revoke-writer") {
        res.json(await faultHarness.revokeWriter());
        return;
      }
      if (action === "force-loss") {
        res.json(await faultHarness.forceLoss());
        return;
      }
      if (action === "reset") {
        res.json(await faultHarness.reset());
        return;
      }
      res.status(400).json({error: "qa_fault_action_unknown"});
    } catch (error) {
      res.status(error.status || 409).json({error: error.code || "qa_fault_failed"});
    }
  });
}

function requireRunnerAccess(hasRunnerAccess) {
  return (req, res, next) => {
    if (typeof hasRunnerAccess !== "function" || !hasRunnerAccess(req)) {
      res.status(404).json({error: "not_found"});
      return;
    }
    next();
  };
}

module.exports = {registerQaFaultRoutes};

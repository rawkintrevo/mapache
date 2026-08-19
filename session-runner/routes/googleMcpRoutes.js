"use strict";

function registerGoogleMcpRoutes({app, hasRunnerAccess, googleMcpStatus}) {
  app.get("/google/mcp/status", (req, res) => {
    if (!hasRunnerAccess(req)) return res.status(404).json({error: "not_found"});
    try {
      res.json(googleMcpStatus());
    } catch (error) {
      console.error("Google MCP status failed", error);
      res.status(500).json({error: "google_mcp_status_failed"});
    }
  });
}

module.exports = {registerGoogleMcpRoutes};

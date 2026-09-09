# Frontend, Functions, and runner compatibility matrix

This matrix is the release checklist for changes that cross the browser app, the
Cloud Functions API, and session-runner images. A revision is **current** when it
contains the code being released and **previous** when it is an already-running
revision that has not been restarted or replaced.

## Contract matrix

| Area | Frontend contract | Functions contract | Runner contract | Mixed-revision expectation |
| --- | --- | --- | --- | --- |
| Session identity | Sends `imageKey` and reads `harnessId`, `imageKey`, `serviceUrl`, and lifecycle status from the session document. | Resolves the curated catalog entry and persists the resolved `harnessId` and image metadata; never trusts an arbitrary image URI. | Reads `HARNESS_ID`, `SESSION_ID`, storage settings, and terminal settings from its environment. | A previous runner may ignore newer metadata and still starts through its legacy harness defaults; the backend keeps legacy-compatible terminal fields. |
| Browser terminal and preview | Uses signed session access URLs returned by the API. | Mints browser/status URLs and forwards the protected runner token only through backend requests. | Accepts browser HMAC tokens for `/terminal`, `/preview/*`, `/healthz`, and `/capabilities`; keeps management routes behind the shutdown token. | A Functions revision can talk to a previous runner only when the requested route and token gate already exist. |
| Workspace skills | Calls neutral `/skills` routes for Pi and Codex sessions. | Proxies neutral routes and falls back to legacy `/pi/skills*` routes for older runners. | Serves neutral routes plus `/pi/skills*` aliases and writes harness-native files. | Current frontend + current Functions + previous runner remains supported by the legacy fallback. |
| Workspace subagents | Calls neutral `/subagents` routes. | Proxies neutral routes and validates the selected harness. | Serves neutral `/subagents` routes and preserves native Pi/Codex file formats. | The Functions API does not advertise V1 chain routes; internal runner chain routes are not a public compatibility promise. |
| Agent auth | Uses `agentAuth` and `authSelection` through the Authentication Center. | Reads/writes canonical `agentAuth` and `authSelection` fields. | Reads canonical fields and materializes native Pi/Codex auth files. | Existing sessions must be recreated or resaved after the compatibility removal deployment. |
| MCP | Saves workspace config and expects restart guidance. | Snapshots workspace config into `MCP_CONFIG` during create/restart. | Materializes `.mcp.json` or Codex config from `MCP_CONFIG`. | Existing sessions do not receive changed MCP config until restart or recreation. |
| File sync | Browser writes call `/sync-files` after Storage writes. | Verifies ownership and calls runner `/workspace/sync-down`. | Pulls Storage objects into the live workspace and periodically syncs local changes up. | A runner sync change requires a new image revision. |
| Generic environment | Selects entry IDs, never secret values. | Resolves private entries while provisioning and writes only runner environment variables. | Consumes resolved environment without persisting it in workspace files or logs. | A previous runner ignores new optional entries; reserved-name validation remains backend-owned. |

## Deployment order

1. Run `npm run check` and focused contract tests.
2. Build and publish every affected runner variant with an immutable source-revision tag.
3. Deploy Functions with `firebase deploy --only functions --project pi-agents-cloud`.
4. Deploy Hosting with `firebase deploy --only hosting --project pi-agents-cloud` when the frontend changed.
5. Restart or recreate existing sessions when a change affects runner image contents, environment variables, native files, or runner routes.
6. Run the relevant Chrome DevTools QA case and record the artifact paths.

Functions must be deployed before Hosting when the frontend consumes a new API field,
route, or response shape. Runner image changes are not retroactive: a running Cloud
Run service keeps its current revision until it is restarted, recreated, or explicitly
updated.

## Local contract evidence

The current/previous expectations are protected by local tests for neutral skill and
subagent routes, legacy skill fallback, canonical auth reads, runner access
token gates, image catalog resolution, and workspace sync path filtering. When a new
cross-layer field or route is added, add a focused fixture/test at the owning boundary
before changing the deployment order above.

import React, {useEffect, useState} from "react";
import {createRoot} from "react-dom/client";
import {TopbarPowerMenu} from "/src/components/layout/TopbarPowerMenu.jsx";
import {getWorkspacePowerPresentation} from "/src/components/sessions/sessionPresentation.js";
import {withVmWorkspaces, pollVmSessions} from "/src/services/vmWorkspaceApi.js";
import "/src/styles.css";

const ws = {id: "vm", name: "VM integration fixture", backend: "compute-engine", state: "active", generation: 1, currentSessionId: "s1"};
window.vmProof = {legacyCalls: 0, actions: [], errors: []};
const api = withVmWorkspaces({getWorkspaces: async () => ({workspaces: [{id: "legacy"}]}),
  getSessions() { window.vmProof.legacyCalls++; }, restartSession() { window.vmProof.legacyCalls++; },
  stopSession() { window.vmProof.legacyCalls++; }, getSessionAccessUrls() { window.vmProof.legacyCalls++; }}, async (url, options) => {
  if (url.endsWith("/workspaces")) return {workspaces: [{...ws}]};
  if (url.endsWith("/sessions")) return {workspace: {...ws}, sessions: [{id: ws.currentSessionId, status: ws.state === "active" ? "running" : "stopped"}]};
  window.vmProof.actions.push({path: new URL(url).pathname, body: options.body});
  if (options.body.expectedGeneration !== ws.generation) throw new Error("stale generation");
  if (url.endsWith("/pause")) ws.state = "stopped";
  if (url.endsWith("/start")) { ws.state = "active"; ws.generation++; ws.currentSessionId = `s${ws.generation}`; }
  return {ok: true};
});
function Fixture() {
  const [session, setSession] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let detach; let active = true;
    api.getWorkspaces().then(() => { if (active) detach = pollVmSessions(api, "vm", values => setSession(values[0]), e => setError(e.message), {intervalMs: 100}); });
    return () => { active = false; detach?.(); };
  }, []);
  const run = action => action().catch(e => { window.vmProof.errors.push(e.message); setError(e.message); });
  return <main style={{padding: 40}}><h1>VM client integration fixture</h1><p>Production power control and API adapter with synthetic responses.</p>
    <p id="session">{session ? `${session.id}: ${session.status}` : "Loading"}</p>
    <TopbarPowerMenu workspacePowerPresentation={getWorkspacePowerPresentation(session)} workspaceOn={session?.status === "running"}
      onToggle={() => run(() => session.status === "running" ? api.stopSession("vm", session.id) : api.restartSession("vm", session.id))}
      onRestart={() => run(() => api.restartSession("vm", session.id))}/>
    <button id="access" onClick={() => run(() => api.getSessionAccessUrls("vm", session.id))}>Get current access</button><p role="alert">{error}</p>
  </main>;
}
createRoot(document.getElementById("root")).render(<Fixture/>);

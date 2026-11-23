const VM_API = "https://us-central1-pi-agents-cloud.cloudfunctions.net/vmApi_v2";

export function withVmWorkspaces(legacy, request, {requestId = () => crypto.randomUUID()} = {}) {
  const machines = new Map();
  const vmRequest = (id, suffix = "", options) => request(`${VM_API}/workspaces/${encodeURIComponent(id)}${suffix}`, options);
  const read = async id => {
    const data = await vmRequest(id, "/sessions");
    if (data.workspace?.backend !== "compute-engine" || data.workspace.id !== id) throw new Error("Invalid VM workspace response");
    machines.set(id, data.workspace);
    return data;
  };
  async function lifecycle(id, sessionId, action) {
    const data = await read(id);
    if (sessionId && data.workspace.currentSessionId !== sessionId) throw new Error("The runtime changed. Refresh before trying again.");
    const resolvedAction = action === "restart" ? (data.workspace.state === "stopped" || data.workspace.state === "released" ? "start" : "replace") : action;
    return vmRequest(id, `/${resolvedAction}`, {method: "POST", body: {
      expectedGeneration: data.workspace.generation, requestId: requestId(),
    }});
  }
  const routed = {
    getMachineConfiguration: id => vmRequest(id, "/configuration"),
    updateMachineConfiguration: (id, body) => vmRequest(id, "/configuration", {method: "PATCH", body}),
    getSessions: id => read(id),
    restartSession: (id, sessionId) => lifecycle(id, sessionId, "restart"),
    stopSession: (id, sessionId) => lifecycle(id, sessionId, "pause"),
    getSessionAccessUrls: async (id, sessionId) => {
      const data = await read(id);
      if (data.workspace.currentSessionId !== sessionId) throw new Error("The runtime changed. Refresh before opening it.");
      return vmRequest(id, "/access", {method: "POST", body: {expectedGeneration: data.workspace.generation}});
    },
  };
  return new Proxy(legacy, {get(target, property) {
    if (property === "isVmWorkspace") return id => machines.has(id);
    if (property === "getWorkspaces") return async () => {
      const old = await target.getWorkspaces();
      const found = new Map(); let cursor = null; const seen = new Set();
      do {
        const page = await request(`${VM_API}/workspaces${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
        for (const ws of page.workspaces || []) {
          if (ws.backend !== "compute-engine" || !ws.id || found.has(ws.id)) throw new Error("Invalid VM workspace listing");
          found.set(ws.id, ws);
        }
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error("VM workspace pagination did not advance");
        if (cursor) seen.add(cursor);
      } while (cursor);
      for (const ws of old.workspaces || []) if (found.has(ws.id)) throw new Error("Workspace provider conflict; refresh after migration completes");
      // Retain known VM identity even after admission disappears. An old UI
      // callback must never fall through to a Cloud Run mutation for that ID.
      for (const [id, ws] of found) machines.set(id, ws);
      return {...old, workspaces: [...(old.workspaces || []), ...found.values()]};
    };
    if (typeof target[property] !== "function") return target[property];
    return (...args) => {
      if (!machines.has(args[0])) return target[property](...args);
      if (routed[property]) return routed[property](...args);
      return Promise.reject(new Error("This action is not available for VM workspaces yet."));
    };
  }});
}

export function pollVmSessions(api, workspaceId, onSessions, onError, {intervalMs = 3000, schedule = setTimeout, cancel = clearTimeout} = {}) {
  let active = true; let timer;
  async function poll() {
    try {
      const data = await api.getSessions(workspaceId);
      if (active) onSessions(data.sessions || []);
    } catch (error) {
      if (active) { onSessions([]); onError(error); }
    } finally { if (active) timer = schedule(poll, intervalMs); }
  }
  void poll();
  return () => { active = false; if (timer !== undefined) cancel(timer); };
}

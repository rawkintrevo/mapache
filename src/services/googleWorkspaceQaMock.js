const GOOGLE_SERVICES = [
  {key: "gmail", displayName: "Gmail", accessLevels: ["read", "write"]},
  {key: "drive", displayName: "Google Drive", accessLevels: ["read", "write"]},
  {key: "docs", displayName: "Google Docs", accessLevels: ["read", "write"]},
];

function mockEnabled() {
  if (!import.meta.env?.DEV) return false;
  if (typeof window === "undefined") return false;
  if (window.location.search.includes("qaGoogleMock=1")) return true;
  return window.localStorage.getItem("mapache.qaGoogleMock") === "1";
}

function mockState() {
  if (typeof window.__mapacheGoogleWorkspaceQaMock === "object") return window.__mapacheGoogleWorkspaceQaMock;
  const state = {nextAccount: 0, connections: [], bindings: {}};
  window.__mapacheGoogleWorkspaceQaMock = state;
  return state;
}

function accountUsage(state, connectionId) {
  return Object.entries(state.bindings)
      .filter(([, binding]) => binding.connectionId === connectionId)
      .map(([workspaceId]) => ({id: workspaceId, name: workspaceId === "workspace-a" ? "Workspace A" : "Workspace B"}));
}

function connectionSummary(state, connection) {
  const workspaces = accountUsage(state, connection.connectionId);
  return {
    ...connection,
    workspaceUsage: {count: workspaces.length, workspaces},
  };
}

function createConnection(state) {
  state.nextAccount += 1;
  const suffix = String.fromCharCode(64 + state.nextAccount);
  const connection = {
    connectionId: `qa-google-${state.nextAccount}`,
    email: `google-${suffix.toLowerCase()}@example.test`,
    displayName: `QA Google Account ${suffix}`,
    status: "connected",
  };
  state.connections.push(connection);
  return connection;
}

function callbackUrl() {
  return "data:text/html,<script>window.close()</script>";
}

export function isGoogleWorkspaceQaMockEnabled() {
  return mockEnabled();
}

export function createGoogleWorkspaceQaMock() {
  if (!mockEnabled()) return {};
  const state = mockState();
  return {
    getGoogleWorkspaceServices: async () => ({services: GOOGLE_SERVICES}),
    getGoogleConnections: async () => ({connections: state.connections.map((connection) => connectionSummary(state, connection))}),
    getGoogleConnection: async (connectionId) => ({
      connection: state.connections.find((entry) => entry.connectionId === connectionId) || null,
      workspaceUsage: {count: accountUsage(state, connectionId).length, workspaces: accountUsage(state, connectionId)},
    }),
    deleteGoogleConnection: async (connectionId) => {
      state.connections = state.connections.filter((connection) => connection.connectionId !== connectionId);
      for (const [workspaceId, binding] of Object.entries(state.bindings)) {
        if (binding.connectionId === connectionId) delete state.bindings[workspaceId];
      }
      return {ok: true};
    },
    getWorkspaceGoogleConnection: async (workspaceId) => {
      const binding = state.bindings[workspaceId] || null;
      const connection = binding ? state.connections.find((entry) => entry.connectionId === binding.connectionId) || null : null;
      return {binding, connection, services: GOOGLE_SERVICES};
    },
    startGoogleConnection: async (workspaceId, body = {}) => {
      const connection = createConnection(state);
      state.bindings[workspaceId] = {
        connectionId: connection.connectionId,
        enabledServices: Array.isArray(body.serviceKeys) && body.serviceKeys.length ? body.serviceKeys : ["gmail"],
      };
      return {authorizationUrl: callbackUrl(), authorizationCompleted: true};
    },
    bindGoogleConnection: async (workspaceId, body = {}) => {
      const connection = state.connections.find((entry) => entry.connectionId === body.connectionId);
      if (!connection) throw new Error("QA Google connection not found");
      state.bindings[workspaceId] = {
        connectionId: connection.connectionId,
        enabledServices: Array.isArray(body.enabledServices) && body.enabledServices.length ? body.enabledServices : ["gmail"],
      };
      return {binding: state.bindings[workspaceId], connection};
    },
    unbindGoogleConnection: async (workspaceId) => {
      delete state.bindings[workspaceId];
      return {ok: true};
    },
  };
}

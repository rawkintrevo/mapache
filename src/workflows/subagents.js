import {
  friendlyWorkspaceSubagentDeleteError,
  friendlyWorkspaceSubagentError,
  friendlyWorkspaceSubagentSaveError,
} from "../utils/friendlyErrors.js";
import {sessionSubagentHarness, sessionSupportsSubagents} from "../utils/sessionHarnesses.js";

function createDefaultSubagentInstructions(harness) {
  const label = harness?.label || "the active harness";
  return `Describe the focused work this ${label} subagent should handle.`;
}

function selectedSession(state) {
  return state.sessions.find((session) => session.id === state.selectedSessionId) || null;
}

export function updateWorkspaceSubagentFormState(state, patch) {
  state.workspaceSubagents = {
    ...state.workspaceSubagents,
    error: "",
    message: "",
    form: {
      ...state.workspaceSubagents.form,
      ...patch,
    },
  };
}

export function editWorkspaceSubagentState(state, subagent) {
  state.workspaceSubagents = {
    ...state.workspaceSubagents,
    error: "",
    message: "",
    form: {
      name: subagent.name || "",
      description: subagent.description || "",
      instructions: subagent.instructions || "",
      editing: true,
    },
  };
}

export function cancelWorkspaceSubagentEditState(state) {
  const harness = sessionSubagentHarness(selectedSession(state));
  state.workspaceSubagents = {
    ...state.workspaceSubagents,
    error: "",
    message: "",
    form: {
      name: "",
      description: "",
      instructions: createDefaultSubagentInstructions(harness),
      editing: false,
    },
  };
}

export async function loadWorkspaceSubagentsState({state, render}) {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  const session = selectedSession(state);
  if (!workspaceId || !sessionId) {
    state.workspaceSubagents = {
      ...state.workspaceSubagents,
      loading: false,
      error: "Select or start an active session to inspect subagents.",
      unavailable: true,
      data: null,
    };
    render();
    return;
  }
  if (!sessionSupportsSubagents(session)) {
    state.workspaceSubagents = {
      ...state.workspaceSubagents,
      loading: false,
      error: "Workspace subagents are available for Pi and Codex sessions only.",
      unavailable: true,
      data: null,
    };
    render();
    return;
  }

  state.workspaceSubagents = {
    ...state.workspaceSubagents,
    loading: true,
    error: "",
    unavailable: false,
    data: state.workspaceSubagents.data || null,
  };
  render();

  try {
    const data = await state.api.getWorkspaceSubagents(workspaceId, sessionId);
    state.workspaceSubagents = {
      ...state.workspaceSubagents,
      loading: false,
      error: "",
      unavailable: false,
      data: data || {subagents: []},
    };
  } catch (error) {
    state.workspaceSubagents = {
      ...state.workspaceSubagents,
      loading: false,
      error: friendlyWorkspaceSubagentError(error),
      unavailable: true,
      data: null,
    };
  }
  render();
}

export async function saveWorkspaceSubagentState({state, loadWorkspaceSubagents, render}) {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  const session = selectedSession(state);
  const harness = sessionSubagentHarness(session);
  const form = state.workspaceSubagents.form || {};
  const payload = {
    name: String(form.name || "").trim(),
    description: String(form.description || "").trim(),
    instructions: String(form.instructions || "").trim(),
  };
  if (!workspaceId || !sessionId) {
    state.workspaceSubagents = {...state.workspaceSubagents, error: "Start an active session before saving a subagent."};
    render();
    return;
  }
  if (!sessionSupportsSubagents(session)) {
    state.workspaceSubagents = {...state.workspaceSubagents, error: "Workspace subagents are available for Pi and Codex sessions only."};
    render();
    return;
  }
  if (!payload.name || !payload.description || !payload.instructions) {
    state.workspaceSubagents = {...state.workspaceSubagents, error: "Enter a subagent name, description, and instructions."};
    render();
    return;
  }

  state.workspaceSubagents = {
    ...state.workspaceSubagents,
    saving: true,
    error: "",
    message: form.editing ? "Saving subagent..." : "Creating subagent...",
  };
  render();

  try {
    await state.api.saveWorkspaceSubagent(workspaceId, sessionId, payload);
    state.workspaceSubagents = {
      ...state.workspaceSubagents,
      saving: false,
      message: `Subagent saved to ${harness?.relativePath || "the workspace subagents directory"}. ${harness?.restartHint || ""}`.trim(),
      form: {
        name: "",
        description: "",
        instructions: createDefaultSubagentInstructions(harness),
        editing: false,
      },
    };
    await loadWorkspaceSubagents();
  } catch (error) {
    state.workspaceSubagents = {
      ...state.workspaceSubagents,
      saving: false,
      error: friendlyWorkspaceSubagentSaveError(error),
      message: "",
    };
    render();
  }
}

export async function deleteWorkspaceSubagentState({state, name, loadWorkspaceSubagents, render}) {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  const session = selectedSession(state);
  const subagentName = String(name || "").trim();
  if (!workspaceId || !sessionId || !subagentName) return;
  if (!sessionSupportsSubagents(session)) return;

  state.workspaceSubagents = {
    ...state.workspaceSubagents,
    saving: true,
    error: "",
    message: "Deleting subagent...",
  };
  render();

  try {
    await state.api.deleteWorkspaceSubagent(workspaceId, sessionId, subagentName);
    state.workspaceSubagents = {
      ...state.workspaceSubagents,
      saving: false,
      message: "Subagent deleted.",
    };
    await loadWorkspaceSubagents();
  } catch (error) {
    state.workspaceSubagents = {
      ...state.workspaceSubagents,
      saving: false,
      error: friendlyWorkspaceSubagentDeleteError(error),
      message: "",
    };
    render();
  }
}

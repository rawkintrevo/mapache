import {
  friendlyWorkspaceSkillDeleteError,
  friendlyWorkspaceSkillError,
  friendlyWorkspaceSkillSaveError,
} from "../utils/friendlyErrors.js";
import {sessionSkillHarness, sessionSupportsWorkspaceSkills} from "../utils/sessionSkills.js";

function stripFrontmatter(content) {
  return String(content || "").replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

function createDefaultSkillContent(harness) {
  const label = harness?.label || "the active agent";
  return `# New Skill\n\nAdd instructions for ${label} here.`;
}

function selectedSession(state) {
  return state.sessions.find((session) => session.id === state.selectedSessionId) || null;
}

export function updateWorkspaceSkillFormState(state, patch) {
  state.workspaceSkills = {
    ...state.workspaceSkills,
    error: "",
    message: "",
    form: {
      ...state.workspaceSkills.form,
      ...patch,
    },
  };
}

export function editWorkspaceSkillState(state, skill) {
  state.workspaceSkills = {
    ...state.workspaceSkills,
    error: "",
    message: "",
    form: {
      name: skill.name || "",
      description: skill.description || "",
      content: stripFrontmatter(skill.content || ""),
      editing: true,
    },
  };
}

export function cancelWorkspaceSkillEditState(state) {
  const harness = sessionSkillHarness(selectedSession(state));
  state.workspaceSkills = {
    ...state.workspaceSkills,
    error: "",
    message: "",
    form: {
      name: "",
      description: "",
      content: createDefaultSkillContent(harness),
      editing: false,
    },
  };
}

export async function loadWorkspaceSkillsState({state, render}) {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  const session = selectedSession(state);
  const harness = sessionSkillHarness(session);
  if (!workspaceId || !sessionId) {
    state.workspaceSkills = {
      ...state.workspaceSkills,
      loading: false,
      error: "Select or start an active session to inspect skills.",
      unavailable: true,
      data: null,
    };
    render();
    return;
  }
  if (!sessionSupportsWorkspaceSkills(session)) {
    state.workspaceSkills = {
      ...state.workspaceSkills,
      loading: false,
      error: "Workspace skill management is available for Pi and Codex sessions only.",
      unavailable: true,
      data: null,
    };
    render();
    return;
  }

  state.workspaceSkills = {
    ...state.workspaceSkills,
    loading: true,
    error: "",
    unavailable: false,
    data: state.workspaceSkills.data || null,
  };
  render();

  try {
    const data = await state.api.getWorkspaceSkills(workspaceId, sessionId);
    state.workspaceSkills = {
      ...state.workspaceSkills,
      loading: false,
      error: "",
      unavailable: false,
      data: data || {skills: [], harness: harness?.id || ""},
    };
  } catch (error) {
    state.workspaceSkills = {
      ...state.workspaceSkills,
      loading: false,
      error: friendlyWorkspaceSkillError(error),
      unavailable: true,
      data: null,
    };
  }
  render();
}

export async function saveWorkspaceSkillState({state, loadWorkspaceSkills, render}) {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  const session = selectedSession(state);
  const harness = sessionSkillHarness(session);
  const form = state.workspaceSkills.form || {};
  const payload = {
    name: String(form.name || "").trim(),
    description: String(form.description || "").trim(),
    content: String(form.content || "").trim(),
  };
  if (!workspaceId || !sessionId) {
    state.workspaceSkills = {...state.workspaceSkills, error: "Start an active session before saving a skill."};
    render();
    return;
  }
  if (!sessionSupportsWorkspaceSkills(session)) {
    state.workspaceSkills = {...state.workspaceSkills, error: "Workspace skill management is available for Pi and Codex sessions only."};
    render();
    return;
  }
  if (!payload.name || !payload.description || !payload.content) {
    state.workspaceSkills = {...state.workspaceSkills, error: "Enter a skill name, description, and Markdown instructions."};
    render();
    return;
  }

  state.workspaceSkills = {
    ...state.workspaceSkills,
    saving: true,
    error: "",
    message: form.editing ? "Saving skill..." : "Creating skill...",
  };
  render();

  try {
    await state.api.saveWorkspaceSkill(workspaceId, sessionId, payload);
    state.workspaceSkills = {
      ...state.workspaceSkills,
      saving: false,
      message: `Skill saved to ${harness?.relativeSkillsPath || "the workspace skill directory"}. ${harness?.restartHint || ""}`.trim(),
      form: {
        name: "",
        description: "",
        content: createDefaultSkillContent(harness),
        editing: false,
      },
    };
    await loadWorkspaceSkills();
  } catch (error) {
    state.workspaceSkills = {
      ...state.workspaceSkills,
      saving: false,
      error: friendlyWorkspaceSkillSaveError(error),
      message: "",
    };
    render();
  }
}

export async function deleteWorkspaceSkillState({state, name, loadWorkspaceSkills, render}) {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  const session = selectedSession(state);
  const skillName = String(name || "").trim();
  if (!workspaceId || !sessionId || !skillName) return;
  if (!sessionSupportsWorkspaceSkills(session)) return;

  state.workspaceSkills = {
    ...state.workspaceSkills,
    saving: true,
    error: "",
    message: "Deleting skill...",
  };
  render();

  try {
    await state.api.deleteWorkspaceSkill(workspaceId, sessionId, skillName);
    state.workspaceSkills = {
      ...state.workspaceSkills,
      saving: false,
      message: "Skill deleted.",
    };
    await loadWorkspaceSkills();
  } catch (error) {
    state.workspaceSkills = {
      ...state.workspaceSkills,
      saving: false,
      error: friendlyWorkspaceSkillDeleteError(error),
      message: "",
    };
    render();
  }
}

export const updatePiSkillFormState = updateWorkspaceSkillFormState;
export const editPiSkillState = editWorkspaceSkillState;
export const cancelPiSkillEditState = cancelWorkspaceSkillEditState;
export const loadPiSkillsState = loadWorkspaceSkillsState;
export const savePiSkillState = saveWorkspaceSkillState;
export const deletePiSkillState = deleteWorkspaceSkillState;

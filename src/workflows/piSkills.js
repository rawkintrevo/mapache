import {
  friendlyPiSkillDeleteError,
  friendlyPiSkillError,
  friendlyPiSkillSaveError,
} from "../utils/friendlyErrors.js";

function stripFrontmatter(content) {
  return String(content || "").replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

export function updatePiSkillFormState(state, patch) {
  state.piSkills = {
    ...state.piSkills,
    error: "",
    message: "",
    form: {
      ...state.piSkills.form,
      ...patch,
    },
  };
}

export function editPiSkillState(state, skill) {
  state.piSkills = {
    ...state.piSkills,
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

export function cancelPiSkillEditState(state) {
  state.piSkills = {
    ...state.piSkills,
    error: "",
    message: "",
    form: {
      name: "",
      description: "",
      content: "# New Skill\n\nAdd instructions for pi here.",
      editing: false,
    },
  };
}

export async function loadPiSkillsState({state, render}) {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  if (!workspaceId || !sessionId) {
    state.piSkills = {
      ...state.piSkills,
      loading: false,
      error: "Select or start an active session to inspect skills.",
      unavailable: true,
      data: null,
    };
    render();
    return;
  }

  state.piSkills = {
    ...state.piSkills,
    loading: true,
    error: "",
    unavailable: false,
    data: state.piSkills.data || null,
  };
  render();

  try {
    const data = await state.api.getPiSkills(workspaceId, sessionId);
    state.piSkills = {
      ...state.piSkills,
      loading: false,
      error: "",
      unavailable: false,
      data: data || {skills: []},
    };
  } catch (error) {
    state.piSkills = {
      ...state.piSkills,
      loading: false,
      error: friendlyPiSkillError(error),
      unavailable: true,
      data: null,
    };
  }
  render();
}

export async function savePiSkillState({state, loadPiSkills, render}) {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  const form = state.piSkills.form || {};
  const payload = {
    name: String(form.name || "").trim(),
    description: String(form.description || "").trim(),
    content: String(form.content || "").trim(),
  };
  if (!workspaceId || !sessionId) {
    state.piSkills = {...state.piSkills, error: "Start an active session before saving a skill."};
    render();
    return;
  }
  if (!payload.name || !payload.description || !payload.content) {
    state.piSkills = {...state.piSkills, error: "Enter a skill name, description, and Markdown instructions."};
    render();
    return;
  }

  state.piSkills = {
    ...state.piSkills,
    saving: true,
    error: "",
    message: form.editing ? "Saving skill..." : "Creating skill...",
  };
  render();

  try {
    await state.api.savePiSkill(workspaceId, sessionId, payload);
    state.piSkills = {
      ...state.piSkills,
      saving: false,
      message: "Skill saved to .pi/skills. Restart Pi in the terminal to force a skill rescan.",
      form: {
        name: "",
        description: "",
        content: "# New Skill\n\nAdd instructions for pi here.",
        editing: false,
      },
    };
    await loadPiSkills();
  } catch (error) {
    state.piSkills = {
      ...state.piSkills,
      saving: false,
      error: friendlyPiSkillSaveError(error),
      message: "",
    };
    render();
  }
}

export async function deletePiSkillState({state, name, loadPiSkills, render}) {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  const skillName = String(name || "").trim();
  if (!workspaceId || !sessionId || !skillName) return;

  state.piSkills = {
    ...state.piSkills,
    saving: true,
    error: "",
    message: "Deleting skill...",
  };
  render();

  try {
    await state.api.deletePiSkill(workspaceId, sessionId, skillName);
    state.piSkills = {
      ...state.piSkills,
      saving: false,
      message: "Skill deleted.",
    };
    await loadPiSkills();
  } catch (error) {
    state.piSkills = {
      ...state.piSkills,
      saving: false,
      error: friendlyPiSkillDeleteError(error),
      message: "",
    };
    render();
  }
}

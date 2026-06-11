import {resetPullRequestForm as resetPullRequestFormState} from "../state/resetters.js";
import {friendlyGitStatusError} from "../utils/friendlyErrors.js";
import {canOpenPullRequestForSession} from "../utils/gitStatus.js";

export async function loadGitStatusState({state, getSelectedSession, resetGitStatus, render}) {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  if (!workspaceId || !sessionId) {
    resetGitStatus();
    return;
  }

  state.gitStatus = {
    loading: true,
    error: "",
    unavailable: false,
    data: null,
    actionMessage: state.gitStatus.actionMessage || "",
    commitMessage: state.gitStatus.commitMessage || "",
    canOpenPr: state.gitStatus.canOpenPr || false,
  };
  render();

  try {
    const data = await state.api.getGitStatus(workspaceId, sessionId);
    if (data && data.ok && data.git === false) {
      state.gitStatus = {
        loading: false,
        error: "",
        unavailable: true,
        data,
        actionMessage: state.gitStatus.actionMessage || "",
        commitMessage: state.gitStatus.commitMessage || "",
        canOpenPr: false,
      };
      render();
      return;
    }
    state.gitStatus = {
      loading: false,
      error: "",
      unavailable: false,
      data: data || null,
      actionMessage: state.gitStatus.actionMessage || "",
      commitMessage: state.gitStatus.commitMessage || "",
      canOpenPr: canOpenPullRequestForSession(getSelectedSession(), data, state.gitStatus.canOpenPr),
    };
  } catch (error) {
    state.gitStatus = {
      loading: false,
      error: friendlyGitStatusError(error),
      unavailable: true,
      data: null,
      actionMessage: state.gitStatus.actionMessage || "",
      commitMessage: state.gitStatus.commitMessage || "",
      canOpenPr: false,
    };
  }
  render();
}

export async function pullGitState({state, loadGitStatus, render}) {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  if (!workspaceId || !sessionId) return;

  state.gitStatus = {...state.gitStatus, actionMessage: "Pulling latest changes...", error: ""};
  render();
  const result = await state.api.pullGit(workspaceId, sessionId);
  state.gitStatus = {
    loading: false,
    error: result && result.pull && result.pull.ok === false ? (result.pull.message || "Git pull reported an issue.") : "",
    unavailable: Boolean(result && result.git === false),
    data: result || null,
    actionMessage: result && result.pull && result.pull.ok === false ?
      "Pull completed with Git conflicts or merge issues." :
      "Pull completed.",
  };
  await loadGitStatus();
}

export async function runGitFileActionState({state, path, action, actionMessage, requestAction, loadGitStatus, render}) {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  if (!workspaceId || !sessionId || !path) return;

  state.gitStatus = {...state.gitStatus, actionMessage, error: ""};
  render();
  const result = await requestAction(workspaceId, sessionId);
  state.gitStatus = {
    loading: false,
    error: "",
    unavailable: Boolean(result && result.git === false),
    data: result || null,
    actionMessage: `${action === "stage" ? "Staged" : "Unstaged"} ${path}.`,
    commitMessage: state.gitStatus.commitMessage || "",
    canOpenPr: state.gitStatus.canOpenPr || false,
  };
  await loadGitStatus();
}

export function updateGitCommitMessageState(state, message) {
  state.gitStatus = {...state.gitStatus, commitMessage: message};
}

export async function commitGitState({state, loadGitStatus, render}) {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  const message = (state.gitStatus.commitMessage || "").trim();
  if (!workspaceId || !sessionId || !message) return;

  state.gitStatus = {...state.gitStatus, actionMessage: "Creating commit...", error: ""};
  render();
  const result = await state.api.commitGit(workspaceId, sessionId, message);
  state.gitStatus = {
    loading: false,
    error: "",
    unavailable: Boolean(result && result.git === false),
    data: result || null,
    actionMessage: result && result.committedHead ? `Committed ${result.committedHead.slice(0, 7)}.` : "Commit created.",
    commitMessage: "",
    canOpenPr: state.gitStatus.canOpenPr || false,
  };
  await loadGitStatus();
}

export async function pushGitState({state, loadGitStatus, render}) {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  if (!workspaceId || !sessionId) return;

  state.gitStatus = {...state.gitStatus, actionMessage: "Pushing current branch...", error: ""};
  render();
  try {
    const result = await state.api.pushGit(workspaceId, sessionId);
    state.gitStatus = {
      loading: false,
      error: result && result.push && result.push.ok === false ? (result.push.message || "Git push reported an issue.") : "",
      unavailable: Boolean(result && result.git === false),
      data: result || null,
      actionMessage: result && result.push && result.push.ok === false ? "Push completed with Git errors." : "Push completed.",
      commitMessage: state.gitStatus.commitMessage || "",
      canOpenPr: result && result.push && result.push.ok === false ? state.gitStatus.canOpenPr : true,
    };
    await loadGitStatus();
  } catch (error) {
    state.gitStatus = {...state.gitStatus, error: friendlyGitStatusError(error), actionMessage: ""};
    render();
  }
}

export function openPullRequestModalState(state) {
  state.pullRequestForm = {...state.pullRequestForm, open: true, error: ""};
}

export function closePullRequestModalState(state) {
  resetPullRequestFormState(state);
}

export function updatePullRequestFormState(state, patch) {
  state.pullRequestForm = {
    ...state.pullRequestForm,
    ...patch,
    error: patch && Object.prototype.hasOwnProperty.call(patch, "error") ? patch.error : state.pullRequestForm.error,
  };
}

export async function submitPullRequestState({state, loadGitStatus, render, openWindow = window.open}) {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  if (!workspaceId || !sessionId) return;

  state.pullRequestForm = {...state.pullRequestForm, error: ""};
  state.gitStatus = {...state.gitStatus, actionMessage: "Opening pull request...", error: ""};
  render();
  try {
    const result = await state.api.openPullRequest(workspaceId, sessionId, {
      title: state.pullRequestForm.title,
      body: state.pullRequestForm.body,
      branchDescription: state.pullRequestForm.branchDescription,
      draft: state.pullRequestForm.draft,
    });
    state.gitStatus = {
      loading: false,
      error: "",
      unavailable: Boolean(result && result.git === false),
      data: result || null,
      actionMessage: result && result.pullRequest && result.pullRequest.number ? `Opened PR #${result.pullRequest.number}.` : "Opened pull request.",
      commitMessage: state.gitStatus.commitMessage || "",
      canOpenPr: true,
    };
    const pullRequestUrl = result && result.pullRequest ? result.pullRequest.url : "";
    resetPullRequestFormState(state);
    await loadGitStatus();
    if (pullRequestUrl) openWindow(pullRequestUrl, "_blank", "noopener");
  } catch (error) {
    state.pullRequestForm = {...state.pullRequestForm, error: friendlyGitStatusError(error)};
    state.gitStatus = {...state.gitStatus, actionMessage: ""};
    render();
  }
}

import {resetPullRequestForm as resetPullRequestFormState} from "../state/resetters.js";
import {friendlyGitStatusError} from "../utils/friendlyErrors.js";
import {canOpenPullRequestForSession} from "../utils/gitStatus.js";
import {isCurrentSessionRequest} from "../utils/sessionRequest.js";

export async function loadGitStatusState({state, getSelectedSession, resetGitStatus, render, request}) {
  if (!isCurrentSessionRequest(request)) return;
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  if (!workspaceId || !sessionId) {
    resetGitStatus();
    return;
  }
  state.gitStatus = {...state.gitStatus, loading: true, error: "", unavailable: false, data: null};
  render();

  try {
    const data = await state.api.getGitStatus(workspaceId, sessionId);
    if (!isCurrentSessionRequest(request)) return;
    if (data && data.ok && data.git === false) {
      state.gitStatus = {...state.gitStatus, loading: false, error: "", unavailable: true, data, canOpenPr: false};
      render();
      return;
    }
    state.gitStatus = {...state.gitStatus, loading: false, error: "", unavailable: false, data: data || null, canOpenPr: canOpenPullRequestForSession(getSelectedSession(), data, state.gitStatus.canOpenPr)};
  } catch (error) {
    if (!isCurrentSessionRequest(request)) return;
    state.gitStatus = {...state.gitStatus, loading: false, error: friendlyGitStatusError(error), unavailable: true, data: null, canOpenPr: false};
  }
  render();
}

export async function loadGitBranchesState({state, render, request}) {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  if (!workspaceId || !sessionId) return;
  state.gitStatus = {...state.gitStatus, branchesLoading: true, error: ""};
  render();
  try {
    const data = await state.api.getGitBranches(workspaceId, sessionId);
    if (request && !request.isCurrent()) return;
    state.gitStatus = {...state.gitStatus, branchesLoading: false, branches: data?.branches || [], error: ""};
  } catch (error) {
    if (request && !request.isCurrent()) return;
    state.gitStatus = {...state.gitStatus, branchesLoading: false, error: friendlyGitStatusError(error)};
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
  state.gitStatus = {...state.gitStatus, loading: false,
    error: result && result.pull && result.pull.ok === false ? (result.pull.message || "Git pull reported an issue.") : "",
    unavailable: Boolean(result && result.git === false),
    data: result || null,
    actionMessage: result && result.pull && result.pull.ok === false ?
      "Pull completed with Git conflicts or merge issues." :
      "Pull completed."};
  await loadGitStatus();
}

export async function runGitFileActionState({state, path, action, actionMessage, requestAction, loadGitStatus, render}) {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  if (!workspaceId || !sessionId || !path) return;

  state.gitStatus = {...state.gitStatus, actionMessage, error: ""};
  render();
  const result = await requestAction(workspaceId, sessionId);
  state.gitStatus = {...state.gitStatus, loading: false, error: "", unavailable: Boolean(result && result.git === false), data: result || null, actionMessage: `${action === "stage" ? "Staged" : "Unstaged"} ${path}.`};
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
  state.gitStatus = {...state.gitStatus, loading: false, error: "", unavailable: Boolean(result && result.git === false), data: result || null, actionMessage: result && result.committedHead ? `Committed ${result.committedHead.slice(0, 7)}.` : "Commit created.", commitMessage: ""};
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
    state.gitStatus = {...state.gitStatus, loading: false, error: result && result.push && result.push.ok === false ? (result.push.message || "Git push reported an issue.") : "", unavailable: Boolean(result && result.git === false), data: result || null, actionMessage: result && result.push && result.push.ok === false ? "Push completed with Git errors." : "Push completed.", canOpenPr: result && result.push && result.push.ok === false ? state.gitStatus.canOpenPr : true};
    await loadGitStatus();
  } catch (error) {
    state.gitStatus = {...state.gitStatus, error: friendlyGitStatusError(error), actionMessage: ""};
    render();
  }
}

export async function checkoutGitBranchState({state, branch, loadGitStatus, loadGitBranches, render}) {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  if (!workspaceId || !sessionId || !branch) return;
  state.gitStatus = {...state.gitStatus, branchActionMessage: `Switching to ${branch}...`, error: ""};
  render();
  try {
    await state.api.checkoutGitBranch(workspaceId, sessionId, branch);
    state.gitStatus = {...state.gitStatus, branchActionMessage: `Switched to ${branch}.`, error: ""};
    await loadGitStatus();
    await loadGitBranches();
  } catch (error) {
    state.gitStatus = {...state.gitStatus, branchActionMessage: "", error: friendlyGitStatusError(error)};
    render();
  }
}

export async function createGitBranchState({state, branch, loadGitStatus, loadGitBranches, render}) {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  if (!workspaceId || !sessionId || !branch) return;
  state.gitStatus = {...state.gitStatus, branchActionMessage: `Creating ${branch}...`, error: ""};
  render();
  try {
    await state.api.createGitBranch(workspaceId, sessionId, branch);
    state.gitStatus = {...state.gitStatus, branchName: "", branchActionMessage: `Created and switched to ${branch}.`, error: ""};
    await loadGitStatus();
    await loadGitBranches();
  } catch (error) {
    state.gitStatus = {...state.gitStatus, branchActionMessage: "", error: friendlyGitStatusError(error)};
    render();
  }
}

export async function ignoreGitPathState({state, path, loadGitStatus, render}) {
  const workspaceId = state.selectedWorkspaceId;
  const sessionId = state.selectedSessionId;
  if (!workspaceId || !sessionId || !path) return;
  state.gitStatus = {...state.gitStatus, actionMessage: `Ignoring ${path}...`, error: ""};
  render();
  try {
    await state.api.ignoreGitPath(workspaceId, sessionId, path);
    state.gitStatus = {...state.gitStatus, actionMessage: `Added ${path} to .gitignore.`, error: ""};
    await loadGitStatus();
  } catch (error) {
    state.gitStatus = {...state.gitStatus, actionMessage: "", error: friendlyGitStatusError(error)};
    render();
  }
}

export function openGitManagerModalState(state) {
  state.gitStatus = {...state.gitStatus, manageOpen: true, error: ""};
}

export function closeGitManagerModalState(state) {
  state.gitStatus = {...state.gitStatus, manageOpen: false, branchName: ""};
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
    state.gitStatus = {...state.gitStatus, loading: false, error: "", unavailable: Boolean(result && result.git === false), data: result || null, actionMessage: result && result.pullRequest && result.pullRequest.number ? `Opened PR #${result.pullRequest.number}.` : "Opened pull request.", canOpenPr: true};
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

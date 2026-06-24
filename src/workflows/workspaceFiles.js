import {createFileEditorState} from "../state/initialState.js";
import {
  shouldUploadWorkspaceFileDirect,
  uploadWorkspaceFileDirect,
} from "../services/workspaceStorage.js";
import {resetFileEditor as resetFileEditorState} from "../state/resetters.js";
import {friendlyFilesError} from "../utils/friendlyErrors.js";

export async function loadWorkspaceFilesState(state) {
  state.workspaceFilesError = "";
  state.workspaceFilesWorkspaceId = workspaceFileScopeId(state);
  if (!state.selectedWorkspaceId) return;

  try {
    const sshSession = selectedSshSession(state);
    const data = sshSession ?
      await state.api.getSshSessionFiles(state.selectedWorkspaceId, sshSession.id) :
      await state.api.getWorkspaceFiles(state.selectedWorkspaceId);
    state.workspaceFiles = data.files || [];
    state.workspaceFilesTruncated = Boolean(data.truncated);
  } catch (error) {
    state.workspaceFilesError = friendlyFilesError(error);
  }
}

export async function uploadWorkspaceFilesState({state, files, loadWorkspaceFiles, render}) {
  const selectedFiles = Array.from(files || []).filter(Boolean);
  if (!state.selectedWorkspaceId || !selectedFiles.length) return;
  if (selectedSshSession(state)) {
    state.workspaceFilesError = "SSH file upload is not available yet. Open or edit files from the SSH file tree.";
    state.workspaceFilesUploadMessage = "";
    render();
    return;
  }

  state.workspaceFilesUploading = true;
  state.workspaceFilesUploadMessage = `Uploading ${selectedFiles.length === 1 ? selectedFiles[0].name : `${selectedFiles.length} files`}...`;
  state.workspaceFilesError = "";
  render();

  try {
    for (const file of selectedFiles) {
      const selectedWorkspace = state.workspaces.find(
          (workspace) => workspace.id === state.selectedWorkspaceId,
      );
      if (shouldUploadWorkspaceFileDirect(file)) {
        await uploadWorkspaceFileDirect(selectedWorkspace, file, (progress) => {
          state.workspaceFilesUploadMessage = `Uploading ${file.name} (${progress.percent}%)...`;
          render();
        });
      } else {
        await state.api.uploadWorkspaceFile(state.selectedWorkspaceId, file);
      }
    }
    if (state.api.syncWorkspaceFiles) {
      state.workspaceFilesUploadMessage = "Syncing uploaded files to active sessions...";
      render();
      await state.api.syncWorkspaceFiles(state.selectedWorkspaceId);
    }
    state.workspaceFilesUploadMessage = selectedFiles.length === 1 ?
      `Uploaded ${selectedFiles[0].name}.` :
      `Uploaded ${selectedFiles.length} files.`;
    await loadWorkspaceFiles();
  } catch (error) {
    state.workspaceFilesError = friendlyFilesError(error);
    state.workspaceFilesUploadMessage = "";
  } finally {
    state.workspaceFilesUploading = false;
  }
  render();
}

export async function downloadWorkspaceFileState({state, render}) {
  const path = state.selectedWorkspaceFilePath;
  if (!state.selectedWorkspaceId || !path) return;
  if (selectedSshSession(state)) {
    state.workspaceFilesError = "SSH file download is not available yet. Open the file and copy its contents from the editor.";
    state.workspaceFilesUploadMessage = "";
    render();
    return;
  }

  const selectedWorkspace = state.workspaces.find(
      (workspace) => workspace.id === state.selectedWorkspaceId,
  );
  state.workspaceFilesUploadMessage = `Downloading ${path.split("/").pop()}...`;
  state.workspaceFilesError = "";
  render();

  try {
    if (!selectedWorkspace?.storagePrefix) throw new Error("workspace_storage_not_configured");
    const {filename, url} = await state.api.getWorkspaceFileDownloadUrl(state.selectedWorkspaceId, path);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename || path.split("/").pop() || "download";
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    state.workspaceFilesUploadMessage = `Started download for ${filename || path.split("/").pop()}.`;
  } catch (error) {
    state.workspaceFilesError = friendlyFilesError(error);
    state.workspaceFilesUploadMessage = "";
  }
  render();
}

export function toggleWorkspaceFileDirState(state, path) {
  const next = new Set(state.expandedFilePaths);
  if (next.has(path)) {
    next.delete(path);
  } else {
    next.add(path);
  }
  state.expandedFilePaths = next;
}

export async function selectWorkspaceFileState({state, path, render}) {
  const workspaceId = state.selectedWorkspaceId;
  state.selectedWorkspaceFilePath = path;
  state.fileEditor = createFileEditorState({
    open: true,
    path,
    name: path.split("/").pop(),
    loading: true,
  });
  render();

  try {
    const sshSession = selectedSshSession(state);
    const data = sshSession ?
      await state.api.getSshSessionFile(workspaceId, sshSession.id, path) :
      await state.api.getWorkspaceFile(workspaceId, path);
    if (!isCurrentFileSelection(state, workspaceId, path)) return;
    state.fileEditor = {
      ...state.fileEditor,
      name: data.name || path.split("/").pop(),
      content: data.content || "",
      originalContent: data.content || "",
      loading: false,
      updatedAt: data.updatedAt || "",
    };
  } catch (error) {
    if (!isCurrentFileSelection(state, workspaceId, path)) return;
    state.fileEditor = {
      ...state.fileEditor,
      loading: false,
      error: friendlyFilesError(error),
    };
  }
  render();
}

export function closeFileEditorState(state) {
  resetFileEditorState(state);
}

export function updateFileEditorContentState(state, content) {
  state.fileEditor.content = content;
}

export async function saveFileEditorState({state, content, loadWorkspaceFiles, render}) {
  if (!state.selectedWorkspaceId || !state.fileEditor.path) return;
  state.fileEditor = {
    ...state.fileEditor,
    content,
    saving: true,
    error: "",
  };
  render();

  try {
    const sshSession = selectedSshSession(state);
    const data = sshSession ?
      await state.api.saveSshSessionFile(state.selectedWorkspaceId, sshSession.id, state.fileEditor.path, content) :
      await state.api.saveWorkspaceFile(
          state.selectedWorkspaceId,
          state.fileEditor.path,
          content,
      );
    state.fileEditor = {
      ...state.fileEditor,
      content,
      originalContent: content,
      saving: false,
      updatedAt: data.updatedAt || state.fileEditor.updatedAt,
    };
    if (!sshSession && state.api.syncWorkspaceFiles) {
      await state.api.syncWorkspaceFiles(state.selectedWorkspaceId);
    }
    await loadWorkspaceFiles();
  } catch (error) {
    state.fileEditor = {
      ...state.fileEditor,
      saving: false,
      error: friendlyFilesError(error),
    };
  }
  render();
}

function isCurrentFileSelection(state, workspaceId, path) {
  return state.selectedWorkspaceId === workspaceId &&
    state.fileEditor.path === path &&
    state.fileEditor.open;
}

function selectedSshSession(state) {
  const session = (state.sessions || []).find((item) => item.id === state.selectedSessionId);
  return session && (session.sessionType === "ssh" || session.terminalKind === "ssh") && session.serviceUrl ? session : null;
}

function workspaceFileScopeId(state) {
  const sshSession = selectedSshSession(state);
  return sshSession ? `${state.selectedWorkspaceId}:${sshSession.id}:ssh` : state.selectedWorkspaceId;
}

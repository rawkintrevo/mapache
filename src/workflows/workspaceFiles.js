import {createFileEditorState} from "../state/initialState.js";
import {resetFileEditor as resetFileEditorState} from "../state/resetters.js";
import {friendlyFilesError} from "../utils/friendlyErrors.js";

export async function loadWorkspaceFilesState(state) {
  state.workspaceFilesError = "";
  state.workspaceFilesWorkspaceId = state.selectedWorkspaceId;
  if (!state.selectedWorkspaceId) return;

  try {
    const data = await state.api.getWorkspaceFiles(state.selectedWorkspaceId);
    state.workspaceFiles = data.files || [];
    state.workspaceFilesTruncated = Boolean(data.truncated);
  } catch (error) {
    state.workspaceFilesError = friendlyFilesError(error);
  }
}

export async function uploadWorkspaceFilesState({state, files, loadWorkspaceFiles, render}) {
  const selectedFiles = Array.from(files || []).filter(Boolean);
  if (!state.selectedWorkspaceId || !selectedFiles.length) return;

  state.workspaceFilesUploading = true;
  state.workspaceFilesUploadMessage = `Uploading ${selectedFiles.length === 1 ? selectedFiles[0].name : `${selectedFiles.length} files`}...`;
  state.workspaceFilesError = "";
  render();

  try {
    for (const file of selectedFiles) {
      await state.api.uploadWorkspaceFile(state.selectedWorkspaceId, file);
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
    const data = await state.api.getWorkspaceFile(workspaceId, path);
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
    const data = await state.api.saveWorkspaceFile(
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

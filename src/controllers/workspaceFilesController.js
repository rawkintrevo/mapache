import {
  closeFileEditorState,
  createWorkspaceDirectoryState,
  createWorkspaceFileState,
  downloadWorkspaceFileState,
  loadWorkspaceFilesState,
  saveFileEditorState,
  selectWorkspaceFileState,
  toggleWorkspaceFileDirState,
  updateFileEditorContentState,
  uploadWorkspaceFilesState,
} from "../workflows/workspaceFiles.js";
import {
  resetFileEditor as resetFileEditorState,
  resetWorkspaceFiles as resetWorkspaceFilesState,
} from "../state/resetters.js";
import {OPERATION_KEYS} from "../utils/operationKeys.js";

export function createWorkspaceFilesController({state, render, runBusy, captureSessionRequest = () => undefined}) {
  async function loadWorkspaceFiles(path = "", request = captureSessionRequest()) {
    await loadWorkspaceFilesState(state, path, request);
  }

  async function refreshWorkspaceFiles() {
    await runBusy(loadWorkspaceFiles, "Working...", OPERATION_KEYS.WORKSPACE_FILES_REFRESH);
  }

  async function uploadWorkspaceFiles(files) {
    await uploadWorkspaceFilesState({state, files, loadWorkspaceFiles, render});
  }

  async function createWorkspaceFile(path) {
    if (path === undefined) {
      path = window.prompt("Create file: enter a name or path.", "");
      if (path === null) return;
    }
    await createWorkspaceFileState({state, path, loadWorkspaceFiles, render});
  }

  async function createWorkspaceDirectory(path) {
    if (path === undefined) {
      path = window.prompt("Create directory: enter a name or path.", "");
      if (path === null) return;
    }
    await createWorkspaceDirectoryState({state, path, loadWorkspaceFiles, render});
  }

  async function downloadWorkspaceFile() {
    await downloadWorkspaceFileState({state, render});
  }

  async function toggleWorkspaceFileDir(path) {
    await toggleWorkspaceFileDirState({state, path, loadWorkspaceFiles, render});
    render();
  }

  async function selectWorkspaceFile(path) {
    await selectWorkspaceFileState({state, path, render});
  }

  function closeFileEditor() {
    closeFileEditorState(state);
    render();
  }

  function updateFileEditorContent(content) {
    updateFileEditorContentState(state, content);
  }

  async function saveFileEditor(content) {
    await saveFileEditorState({state, content, loadWorkspaceFiles, render});
  }

  function resetWorkspaceFiles() {
    resetWorkspaceFilesState(state);
  }

  function resetFileEditor() {
    resetFileEditorState(state);
  }

  return {
    closeFileEditor,
    createWorkspaceDirectory,
    createWorkspaceFile,
    downloadWorkspaceFile,
    loadWorkspaceFiles,
    refreshWorkspaceFiles,
    resetFileEditor,
    resetWorkspaceFiles,
    saveFileEditor,
    selectWorkspaceFile,
    toggleWorkspaceFileDir,
    updateFileEditorContent,
    uploadWorkspaceFiles,
  };
}

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

export function createWorkspaceFilesController({state, render, runBusy}) {
  async function loadWorkspaceFiles(path = "") {
    await loadWorkspaceFilesState(state, path);
  }

  async function refreshWorkspaceFiles() {
    await runBusy(loadWorkspaceFiles);
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

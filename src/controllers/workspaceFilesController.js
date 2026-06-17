import {
  closeFileEditorState,
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
  async function loadWorkspaceFiles() {
    await loadWorkspaceFilesState(state);
  }

  async function refreshWorkspaceFiles() {
    await runBusy(loadWorkspaceFiles);
  }

  async function uploadWorkspaceFiles(files) {
    await uploadWorkspaceFilesState({state, files, loadWorkspaceFiles, render});
  }

  async function downloadWorkspaceFile() {
    await downloadWorkspaceFileState({state, render});
  }

  function toggleWorkspaceFileDir(path) {
    toggleWorkspaceFileDirState(state, path);
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

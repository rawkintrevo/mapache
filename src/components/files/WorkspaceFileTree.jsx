import "./WorkspaceFileTree.css";
import {formatDate} from "../../utils/formatDate.js";
import {buildFileTree, countFolderFiles} from "./fileTree.js";
import {formatBytes} from "./formatBytes.js";

function FileNodes({childrenMap, depth = 0, options}) {
  const folders = Array.from(childrenMap.values()).sort((left, right) => left.name.localeCompare(right.name));
  return folders.flatMap((folder) => {
    const expanded = options.expandedPaths.has(folder.path);
    const rows = [
      <button
        className="file-row folder-row"
        key={`folder-${folder.path}`}
        style={{"--depth": depth}}
        title={folder.path}
        type="button"
        onClick={() => options.onToggleWorkspaceFileDir(folder.path)}
      >
        <span aria-hidden="true" className="icon">{expanded ? "▾" : "▸"}</span>
        <span aria-hidden="true" className="icon">{expanded ? "▣" : "▢"}</span>
        <span className="file-name">{folder.name}</span>
        <span className="file-count">{countFolderFiles(folder)}</span>
      </button>,
    ];

    if (expanded) {
      rows.push(
        <FileNodes childrenMap={folder.children} depth={depth + 1} key={`children-${folder.path}`} options={options} />,
        <Files depth={depth + 1} files={folder.files} key={`files-${folder.path}`} options={options} />,
      );
    }
    return rows;
  });
}

function Files({depth, files, options}) {
  return files
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((file) => (
        <button
          className={`file-row ${file.path === options.selectedPath ? "active" : ""}`}
          key={file.path}
          style={{"--depth": depth}}
          title={`${file.path}${file.updatedAt ? `\nUpdated ${formatDate(file.updatedAt)}` : ""}`}
          type="button"
          onClick={() => options.onSelectWorkspaceFile(file.path)}
        >
          <span className="file-spacer" />
          <span aria-hidden="true" className="icon">□</span>
          <span className="file-name">{file.name}</span>
          <span className="file-size">{formatBytes(file.size)}</span>
        </button>
      ));
}

export function WorkspaceFileTree({state, onSelectWorkspaceFile, onToggleWorkspaceFileDir}) {
  const uploadStatus = state.workspaceFilesUploadMessage ? (
    <p className="file-status">{state.workspaceFilesUploadMessage}</p>
  ) : null;

  if (!state.selectedWorkspaceId) {
    return <p className="empty">Select a workspace to view files.</p>;
  }

  if (state.workspaceFilesWorkspaceId !== state.selectedWorkspaceId) {
    return (
      <>
        {uploadStatus}
        <p className="empty">Refresh files for this workspace.</p>
      </>
    );
  }

  if (state.workspaceFilesError) {
    return (
      <>
        {uploadStatus}
        <p className="file-error">{state.workspaceFilesError}</p>
      </>
    );
  }

  if (!state.workspaceFiles.length) {
    return (
      <>
        {uploadStatus}
        <p className="empty">No files synced yet.</p>
      </>
    );
  }

  const tree = buildFileTree(state.workspaceFiles);
  const options = {
    expandedPaths: state.expandedFilePaths,
    onSelectWorkspaceFile,
    onToggleWorkspaceFileDir,
    selectedPath: state.selectedWorkspaceFilePath,
  };

  return (
    <div className="file-tree">
      {uploadStatus}
      <FileNodes childrenMap={tree.children} options={options} />
      <Files depth={0} files={tree.files} options={options} />
      {state.workspaceFilesTruncated ? <p className="empty">Showing first 500 files.</p> : null}
    </div>
  );
}

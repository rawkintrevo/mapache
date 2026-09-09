import "./Drawers.css";
import {useEffect, useRef, useState} from "react";
import {Download, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw} from "lucide-react";
import {DrawerSessionList} from "./DrawerSessionList.jsx";
import {DrawerSection} from "./DrawerSection.jsx";
import {UserMenu} from "./UserMenu.jsx";
import {Button} from "../common/Button.jsx";
import {WorkspaceFileTree} from "../files/WorkspaceFileTree.jsx";
import {hasPendingOperations} from "../../state/pendingOperations.js";

export function LeftDrawer({
  state,
  onDeleteSession,
  onEditSession,
  onOpenSessionModal,
  onRefresh,
  onRefreshWorkspaceFiles,
  onRetryProvisioningSession,
  onDownloadWorkspaceFile,
  onCreateWorkspaceDirectory,
  onCreateWorkspaceFile,
  onUploadWorkspaceFiles,
  onSelectSession,
  onSelectWorkspaceFile,
  onShowAdmin,
  onShowProfile,
  onSignOut,
  onStopSession,
  onToggleDrawer,
  onToggleDrawerSection,
  onToggleWorkspaceFileDir,
}) {
  const fileInputRef = useRef(null);
  const fileActionsRef = useRef(null);
  const [fileActionsOpen, setFileActionsOpen] = useState(false);
  const selectedSession = (state.sessions || []).find((session) => session.id === state.selectedSessionId);
  const busy = hasPendingOperations(state.pendingOperations);
  const fileScopeIsSsh = Boolean(
      selectedSession &&
      (selectedSession.sessionType === "ssh" || selectedSession.terminalKind === "ssh") &&
      selectedSession.serviceUrl,
  );

  useEffect(() => {
    if (!fileActionsOpen) return undefined;

    function closeOnOutsidePointer(event) {
      if (!fileActionsRef.current?.contains(event.target)) setFileActionsOpen(false);
    }

    function closeOnEscape(event) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setFileActionsOpen(false);
      fileActionsRef.current?.querySelector(".files-action-trigger")?.focus();
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    fileActionsRef.current?.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [fileActionsOpen]);

  function chooseFileAction(action) {
    setFileActionsOpen(false);
    if (action === "upload") {
      fileInputRef.current?.click();
    } else if (action === "create-file") {
      onCreateWorkspaceFile?.();
    } else {
      onCreateWorkspaceDirectory?.();
    }
  }

  const toggleButton = (
    <Button
      aria-expanded={String(!state.drawerCollapsed)}
      aria-label={state.drawerCollapsed ? "Expand drawer" : "Collapse drawer"}
      className="drawer-toggle"
      icon={true}
      title={state.drawerCollapsed ? "Expand drawer" : "Collapse drawer"}
      tooltip={state.drawerCollapsed ? "Expand drawer" : "Collapse drawer"}
      variant="secondary"
      onClick={onToggleDrawer}
    >
      {state.drawerCollapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
    </Button>
  );

  if (state.drawerCollapsed) {
    return <aside className="drawer navigation-drawer collapsed">{toggleButton}</aside>;
  }

  return (
    <aside className="drawer navigation-drawer">
      <div className="drawer-content">
        <div className="drawer-header">
          <h2>Navigation</h2>
          {toggleButton}
        </div>
        <DrawerSection
          actions={[
            <div className="files-action-menu" key="file-actions" ref={fileActionsRef}>
              <Button
                aria-controls="files-action-menu"
                aria-expanded={fileActionsOpen}
                aria-haspopup="menu"
                aria-label="File actions"
                className="files-action-trigger"
                disabled={busy || state.workspaceFilesUploading || !state.selectedWorkspaceId}
                icon={true}
                size="compact"
                title="File actions"
                tooltip="File actions"
                variant="secondary"
                onClick={() => setFileActionsOpen((open) => !open)}
              >
                <Plus aria-hidden="true" />
              </Button>
              {fileActionsOpen ? (
                <div aria-label="File actions" className="files-action-popover" id="files-action-menu" role="menu">
                  <Button
                    role="menuitem"
                    onClick={() => chooseFileAction("upload")}
                  >
                    Upload file
                  </Button>
                  <Button
                    disabled={fileScopeIsSsh}
                    role="menuitem"
                    title={fileScopeIsSsh ? "File creation is not available for SSH sessions." : undefined}
                    onClick={() => chooseFileAction("create-file")}
                  >
                    Create file
                  </Button>
                  <Button
                    disabled={fileScopeIsSsh}
                    role="menuitem"
                    title={fileScopeIsSsh ? "Directory creation is not available for SSH sessions." : undefined}
                    onClick={() => chooseFileAction("create-directory")}
                  >
                    Create directory
                  </Button>
                </div>
              ) : null}
            </div>,
            <Button
              aria-label="Download selected file"
              disabled={busy || state.workspaceFilesUploading || !state.selectedWorkspaceFilePath}
              icon={true}
              key="download-file"
              size="compact"
              title="Download selected file"
              tooltip="Download selected file"
              variant="secondary"
              onClick={onDownloadWorkspaceFile}
            >
              <Download aria-hidden="true" />
            </Button>,
            <Button
              aria-label="Refresh files"
              disabled={busy || state.workspaceFilesUploading || !state.selectedWorkspaceId}
              icon={true}
              key="refresh-files"
              size="compact"
              title="Refresh files"
              tooltip="Refresh files"
              variant="secondary"
              onClick={onRefreshWorkspaceFiles}
            >
              <RefreshCw aria-hidden="true" />
            </Button>,
          ]}
          id="left-files"
          state={state}
          title="Files"
          onToggleDrawerSection={onToggleDrawerSection}
        >
          <input
            ref={fileInputRef}
            className="visually-hidden"
            multiple={true}
            tabIndex={-1}
            type="file"
            onChange={(event) => {
              onUploadWorkspaceFiles?.(event.target.files);
              event.target.value = "";
            }}
          />
          <WorkspaceFileTree
            state={state}
            onSelectWorkspaceFile={onSelectWorkspaceFile}
            onToggleWorkspaceFileDir={onToggleWorkspaceFileDir}
          />
        </DrawerSection>
        <DrawerSection
          actions={[
            <Button
              aria-label="Create session"
              disabled={busy || !state.selectedWorkspaceId}
              icon={true}
              key="create-session"
              size="compact"
              title="Create session"
              tooltip="Create session"
              variant="secondary"
              onClick={onOpenSessionModal}
            >
              <Plus aria-hidden="true" />
            </Button>,
          ]}
          id="left-sessions"
          state={state}
          title="Sessions"
          onToggleDrawerSection={onToggleDrawerSection}
        >
          <DrawerSessionList
            state={state}
            onDeleteSession={onDeleteSession}
            onEditSession={onEditSession}
            onRetryProvisioningSession={onRetryProvisioningSession}
            onSelectSession={onSelectSession}
            onStopSession={onStopSession}
          />
        </DrawerSection>
      </div>
      <UserMenu
        state={state}
        onRefresh={onRefresh}
        onShowAdmin={onShowAdmin}
        onShowProfile={onShowProfile}
        onSignOut={onSignOut}
      />
    </aside>
  );
}

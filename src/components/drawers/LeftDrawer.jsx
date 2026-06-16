import {useRef} from "react";
import {Download, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw} from "lucide-react";
import {DrawerSessionList} from "./DrawerSessionList.jsx";
import {DrawerSection} from "./DrawerSection.jsx";
import {UserMenu} from "./UserMenu.jsx";
import {WorkspaceDrawerList} from "./WorkspaceDrawerList.jsx";
import {Button} from "../common/Button.jsx";
import {WorkspaceFileTree} from "../files/WorkspaceFileTree.jsx";

export function LeftDrawer({
  state,
  onDeleteSession,
  onOpenSessionModal,
  onOpenWorkspaceModal,
  onRefresh,
  onRefreshWorkspaceFiles,
  onDownloadWorkspaceFile,
  onUploadWorkspaceFiles,
  onSelectSession,
  onSelectWorkspace,
  onSelectWorkspaceFile,
  onShowProfile,
  onSignOut,
  onStopSession,
  onToggleDrawer,
  onToggleDrawerSection,
  onToggleWorkspaceFileDir,
}) {
  const fileInputRef = useRef(null);
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
            <Button
              aria-label="Add Workspace"
              icon={true}
              key="add-workspace"
              size="compact"
              tooltip="Add Workspace"
              variant="secondary"
              onClick={onOpenWorkspaceModal}
            >
              <Plus aria-hidden="true" />
            </Button>,
          ]}
          id="left-workspaces"
          state={state}
          title="Workspaces"
          onToggleDrawerSection={onToggleDrawerSection}
        >
          <WorkspaceDrawerList
            busy={state.busy}
            selectedWorkspaceId={state.selectedWorkspaceId}
            workspaces={state.workspaces}
            onOpenSessionModal={onOpenSessionModal}
            onSelectWorkspace={onSelectWorkspace}
          />
        </DrawerSection>
        <DrawerSection
          actions={[
            <Button
              aria-label="Upload file"
              disabled={state.busy || state.workspaceFilesUploading || !state.selectedWorkspaceId}
              icon={true}
              key="upload-file"
              size="compact"
              title="Upload file"
              tooltip="Upload file"
              variant="secondary"
              onClick={() => fileInputRef.current?.click()}
            >
              <Plus aria-hidden="true" />
            </Button>,
            <Button
              aria-label="Download selected file"
              disabled={state.busy || state.workspaceFilesUploading || !state.selectedWorkspaceFilePath}
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
              disabled={state.busy || state.workspaceFilesUploading || !state.selectedWorkspaceId}
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
              disabled={state.busy || !state.selectedWorkspaceId}
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
            onSelectSession={onSelectSession}
            onStopSession={onStopSession}
          />
        </DrawerSection>
      </div>
      <UserMenu state={state} onRefresh={onRefresh} onShowProfile={onShowProfile} onSignOut={onSignOut} />
    </aside>
  );
}

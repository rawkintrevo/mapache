import {
  ChevronDown,
  ChevronRight,
  createElement as createLucideIcon,
  FileText,
  Folder,
  FolderOpen,
  Menu,
  PanelLeftClose,
  RefreshCw,
  Save,
  SquareStop,
  X,
} from "lucide";
import {createElement, formatDate, replaceChildren} from "./utils.js";
import {sessionImages} from "../config/sessionImages.js";

const cpuOptions = ["1", "2", "4"];
const memoryOptions = ["1Gi", "2Gi", "4Gi", "8Gi"];

export function renderAuthScreen(root, handlers) {
  const signInButton = createElement("button", {type: "button"}, "Sign in with Google");
  signInButton.addEventListener("click", handlers.onSignIn);
  const storyText = "Once, I got so angry at Anthropic for ruining all the open souce foundations...";
  const followupText = "that I made Mapache Tools using only rage and spite.";
  const closingText = "I hope you enjoy it.";

  replaceChildren(root, createElement("div", {className: "auth"}, [
    createElement("aside", {
      ariaLabel: storyText,
      className: "auth-story",
      style: "--story-delay: 700ms;",
    }, renderStoryWords(storyText)),
    createElement("aside", {
      ariaLabel: followupText,
      className: "auth-story auth-story-followup",
      style: "--story-delay: 6200ms;",
    }, renderStoryWords(followupText)),
    createElement("section", {
      className: "auth-panel",
      style: "--story-delay: 10400ms;",
    }, [
      createElement("p", {
        ariaLabel: closingText,
        className: "auth-panel-message",
      }, renderStoryWords(closingText)),
      signInButton,
    ]),
  ]));
}

function renderStoryWords(text) {
  let letterIndex = 0;

  return text.split(" ").map((word) => createElement("span", {
    ariaHidden: "true",
    className: "story-word",
  }, Array.from(word).map((letter) => {
    const letterElement = createElement("span", {
      className: "story-letter",
      style: `--letter-delay: ${letterIndex * 45}ms;`,
    }, letter);
    letterIndex += 1;
    return letterElement;
  })));
}

export function renderFatalError(root, error) {
  replaceChildren(root, createElement("div", {className: "auth"}, [
    createElement("section", {className: "auth-panel"}, [
      createElement("h1", {}, "Configuration error"),
      createElement("p", {}, error.message || "The app could not start."),
    ]),
  ]));
}

export function renderAppShell(root, props) {
  const {state} = props;
  const selectedWorkspace = state.workspaces.find(
      (workspace) => workspace.id === state.selectedWorkspaceId,
  );
  const selectedSession = state.sessions.find(
      (session) => session.id === state.selectedSessionId,
  );
  const workspaceContent = selectedSession ? [
    renderSessionDetail(selectedSession, props),
  ] : [
    renderWorkspaceHeader(selectedWorkspace),
    state.error ? createElement("div", {className: "error"}, state.error) : null,
    renderSessionList(state, props),
  ];

  replaceChildren(root, createElement("div", {className: "app"}, [
    renderTopbar(props),
    createElement("main", {className: state.drawerCollapsed ? "drawer-collapsed" : ""}, [
      renderSidebar(props),
      createElement("section", {className: "workspace"}, workspaceContent),
    ]),
    state.sessionModalOpen ? renderSessionModal(props) : null,
    state.fileEditor.open ? renderFileEditorModal(props) : null,
    state.pullRequestForm.open ? renderPullRequestModal(props) : null,
  ]));
}

function renderTopbar({state, onSignOut, onRefresh}) {
  const refreshButton = createElement("button", {
    className: "secondary",
    disabled: state.busy,
    type: "button",
  }, state.busy ? "Working..." : "Refresh");
  refreshButton.addEventListener("click", onRefresh);

  const signOutButton = createElement("button", {
    className: "secondary",
    disabled: state.busy,
    type: "button",
  }, "Sign out");
  signOutButton.addEventListener("click", onSignOut);

  return createElement("header", {className: "topbar"}, [
    createElement("div", {className: "brand"}, [
      createElement("div", {className: "mark", ariaHidden: "true"}, "pi"),
      createElement("h1", {}, "Mapache Tools"),
    ]),
    createElement("div", {className: "userbar"}, [
      createElement("span", {}, userLabel(state)),
      refreshButton,
      signOutButton,
    ]),
  ]);
}

function userLabel(state) {
  return (state.profile && (state.profile.displayName || state.profile.email)) ||
    state.user.email ||
    state.user.uid;
}

function renderSidebar(props) {
  const {
    state,
    onCreateWorkspace,
    onConnectGithub,
    onLoadConnectedRepos,
    onOpenSessionModal,
    onRefreshWorkspaceFiles,
    onSelectWorkspaceFile,
    onSelectSession,
    onSelectWorkspace,
    onStopSession,
    onToggleDrawer,
    onToggleWorkspaceFileDir,
  } = props;

  const toggleButton = createElement("button", {
    "aria-expanded": String(!state.drawerCollapsed),
    ariaLabel: state.drawerCollapsed ? "Expand drawer" : "Collapse drawer",
    className: "drawer-toggle secondary",
    title: state.drawerCollapsed ? "Expand drawer" : "Collapse drawer",
    type: "button",
  }, renderIcon(state.drawerCollapsed ? Menu : PanelLeftClose));
  toggleButton.addEventListener("click", onToggleDrawer);

  if (state.drawerCollapsed) {
    return createElement("aside", {className: "drawer collapsed"}, [
      toggleButton,
    ]);
  }

  const nameInput = createElement("input", {
    autocomplete: "off",
    name: "name",
    placeholder: "default",
    required: true,
  });
  const sourceBlankInput = createElement("input", {
    checked: true,
    name: "workspaceSource",
    type: "radio",
    value: "blank",
  });
  const sourceGithubInput = createElement("input", {
    name: "workspaceSource",
    type: "radio",
    value: "github",
  });
  const repoUrlInput = createElement("input", {
    autocomplete: "off",
    name: "repoUrl",
    placeholder: "https://github.com/owner/repo",
    type: "url",
  });
  const branchInput = createElement("input", {
    autocomplete: "off",
    name: "branch",
    placeholder: "main",
  });
  const repoPicker = state.repoPicker || {loading: false, error: "", repos: [], attempted: false};

  const repoSelect = createElement("select", {
    disabled: repoPicker.loading || !repoPicker.repos.length,
    name: "connectedRepo",
  }, [
    createElement("option", {value: ""}, repoPicker.loading ? "Loading..." : "Select a repository"),
    ...(repoPicker.repos || []).map((repo) => createElement("option", {
      value: JSON.stringify({
        mode: "connected",
        owner: repo.owner || "",
        repo: repo.name || "",
        fullName: repo.fullName || "",
        installationId: repo.installationId || "",
        repoId: repo.repoId || "",
        repoUrl: repo.cloneUrl || repo.repoUrl || "",
        defaultBranch: repo.defaultBranch || "",
        private: Boolean(repo.private),
        visibility: repo.visibility || (repo.private ? "private" : "public") || "public",
      }),
    }, repo.fullName || `${repo.owner || ""}/${repo.name || ""}`)),
  ]);

  const repoPickerSection = createElement("div", {className: "repo-picker hidden"}, [
    createElement("label", {}, [
      createElement("span", {}, "Connected repository"),
      repoSelect,
    ]),
    createGithubConnectButton({repoPicker, onConnectGithub}),
    repoPicker.error === "github_app_not_configured" ?
      createElement("p", {className: "subtle repo-picker-fallback"}, "GitHub App not configured. Enter a public repository URL below.") :
      repoPicker.error ?
      createElement("p", {className: "subtle repo-picker-fallback"}, repoPicker.error) :
      null,
  ]);

  const githubFields = createElement("div", {className: "workspace-source-fields hidden"}, [
    createElement("label", {}, [
      createElement("span", {}, "GitHub repo URL"),
      repoUrlInput,
    ]),
    createElement("label", {}, [
      createElement("span", {}, "Branch (optional)"),
      branchInput,
    ]),
  ]);
  const form = createElement("form", {className: "workspace-create"}, [
    createElement("label", {}, [
      createElement("span", {}, "Workspace"),
      nameInput,
    ]),
    createElement("div", {className: "workspace-source-choice"}, [
      createElement("label", {className: "source-choice"}, [
        sourceBlankInput,
        createElement("span", {}, "Blank"),
      ]),
      createElement("label", {className: "source-choice"}, [
        sourceGithubInput,
        createElement("span", {}, "GitHub"),
      ]),
    ]),
    repoPickerSection,
    githubFields,
    createElement("button", {
      disabled: state.busy,
      type: "submit",
    }, "Create"),
  ]);
  const parseConnectedRepoValue = () => {
    if (!repoSelect.value) return null;
    try {
      return JSON.parse(repoSelect.value);
    } catch (error) {
      return null;
    }
  };
  const syncSourceFields = () => {
    const githubSelected = sourceGithubInput.checked;
    githubFields.classList.toggle("hidden", !githubSelected);
    repoPickerSection.classList.toggle("hidden", !githubSelected);
    repoUrlInput.required = githubSelected;
    repoUrlInput.disabled = !githubSelected;
    branchInput.disabled = !githubSelected;

    if (githubSelected && onLoadConnectedRepos && !repoPicker.loading && !repoPicker.attempted) {
      onLoadConnectedRepos();
    }
  };
  const syncConnectedRepoSelection = () => {
    const connectedRepo = parseConnectedRepoValue();
    if (!connectedRepo) return;
    if (connectedRepo.repoUrl) {
      repoUrlInput.value = connectedRepo.repoUrl;
    }
    if (!branchInput.value.trim() && connectedRepo.defaultBranch) {
      branchInput.value = connectedRepo.defaultBranch;
    }
  };
  sourceBlankInput.addEventListener("change", syncSourceFields);
  sourceGithubInput.addEventListener("change", syncSourceFields);
  repoSelect.addEventListener("change", syncConnectedRepoSelection);
  repoUrlInput.addEventListener("input", () => {
    const connectedRepo = parseConnectedRepoValue();
    if (!connectedRepo) return;
    if (repoUrlInput.value.trim() !== (connectedRepo.repoUrl || "")) {
      repoSelect.value = "";
    }
  });
  syncSourceFields();
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    let source;
    if (sourceGithubInput.checked) {
      const connectedRepo = parseConnectedRepoValue();
      if (connectedRepo) {
        source = {
          type: "github",
          mode: "connected",
          repoUrl: connectedRepo.repoUrl || repoUrlInput.value.trim(),
          owner: connectedRepo.owner || "",
          repo: connectedRepo.repo || "",
          repoId: connectedRepo.repoId || undefined,
          installationId: connectedRepo.installationId || undefined,
          visibility: connectedRepo.visibility || undefined,
          requestedBranch: branchInput.value.trim() || connectedRepo.defaultBranch || undefined,
        };
      } else {
        source = {
          type: "github",
          repoUrl: repoUrlInput.value.trim(),
          requestedBranch: branchInput.value.trim() || undefined,
        };
      }
    } else {
      source = {type: "blank"};
    }
    onCreateWorkspace({
      name: nameInput.value.trim() || "Default workspace",
      source,
    });
  });

  const list = state.workspaces.length ?
    state.workspaces.map((workspace) => renderWorkspaceRow(
        workspace,
        workspace.id === state.selectedWorkspaceId,
        state.busy,
        onSelectWorkspace,
        onOpenSessionModal,
    )) :
    [createElement("p", {className: "empty"}, "No workspaces yet.")];

  return createElement("aside", {className: "drawer"}, [
    createElement("div", {className: "drawer-header"}, [
      createElement("h2", {}, "Navigation"),
      toggleButton,
    ]),
    createElement("section", {className: "drawer-section"}, [
      createElement("div", {className: "drawer-section-heading"}, [
        createElement("h3", {}, "Workspaces"),
      ]),
      form,
      createElement("div", {className: "list"}, list),
    ]),
    createElement("section", {className: "drawer-section"}, [
      createElement("div", {className: "drawer-section-heading"}, [
        createElement("h3", {}, "Files"),
        createFilesRefreshButton(state, onRefreshWorkspaceFiles),
      ]),
      renderWorkspaceFileTree(state, onToggleWorkspaceFileDir, onSelectWorkspaceFile),
    ]),
    createElement("section", {className: "drawer-section"}, [
      createElement("div", {className: "drawer-section-heading"}, [
        createElement("h3", {}, "Sessions"),
        createSessionButton(state, onOpenSessionModal),
      ]),
      renderDrawerSessionList(state, onSelectSession, onStopSession),
    ]),
  ]);
}

function createGithubConnectButton({repoPicker, onConnectGithub}) {
  if ((repoPicker.repos || []).length) {
    return null;
  }
  const button = createElement("button", {
    className: "secondary github-connect-button",
    disabled: repoPicker.loading || !onConnectGithub,
    type: "button",
  }, repoPicker.loading ? "Loading..." : "Connect GitHub");
  if (onConnectGithub) {
    button.addEventListener("click", onConnectGithub);
  }
  return button;
}

function renderIcon(iconNode) {
  return createLucideIcon(iconNode, {
    "aria-hidden": "true",
    class: "icon",
    height: "18",
    width: "18",
  });
}

function createSessionButton(state, onOpenSessionModal) {
  const button = createElement("button", {
    ariaLabel: "Create session",
    className: "icon-button compact",
    disabled: state.busy || !state.selectedWorkspaceId,
    title: "Create session",
    type: "button",
  }, "+");
  button.addEventListener("click", onOpenSessionModal);
  return button;
}

function createFilesRefreshButton(state, onRefreshWorkspaceFiles) {
  const button = createElement("button", {
    ariaLabel: "Refresh files",
    className: "icon-button compact secondary",
    disabled: state.busy || !state.selectedWorkspaceId,
    title: "Refresh files",
    type: "button",
  }, renderIcon(RefreshCw));
  button.addEventListener("click", onRefreshWorkspaceFiles);
  return button;
}

function renderWorkspaceRow(workspace, isActive, busy, onSelectWorkspace, onOpenSessionModal) {
  const selectButton = createElement("button", {
    className: "workspace-select",
    type: "button",
  }, [
    createElement("span", {className: "row-title"}, [
      createElement("span", {}, workspace.name),
      createElement("span", {className: "pill"}, workspace.id.slice(0, 5)),
    ]),
    createElement("span", {className: "subtle"}, workspaceSourceSummary(workspace)),
  ]);
  selectButton.addEventListener("click", () => onSelectWorkspace(workspace.id));

  const addButton = createElement("button", {
    ariaLabel: `Create session in ${workspace.name}`,
    className: "workspace-add",
    disabled: busy,
    title: "Create session",
    type: "button",
  }, "+");
  addButton.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!isActive) onSelectWorkspace(workspace.id);
    onOpenSessionModal();
  });

  return createElement("div", {className: `row workspace-row ${isActive ? "active" : ""}`}, [
    selectButton,
    isActive ? addButton : null,
  ]);
}

function renderDrawerSessionList(state, onSelectSession, onStopSession) {
  if (!state.selectedWorkspaceId) {
    return createElement("p", {className: "empty"}, "Select a workspace to view sessions.");
  }

  if (!state.sessions.length) {
    return createElement("p", {className: "empty"}, "No sessions in this workspace.");
  }

  return createElement("div", {className: "list"}, state.sessions.map((session) => {
    const button = createElement("button", {
      className: "session-select",
      type: "button",
    }, [
      createElement("span", {className: "session-title"}, [
        createElement("span", {}, session.name),
        createElement("span", {className: "pill"}, session.status),
      ]),
      createElement("span", {className: "subtle"}, `${session.resources.cpu} CPU / ${session.resources.memory}`),
    ]);
    button.addEventListener("click", () => onSelectSession(session.id));

    return createElement("div", {
      className: `row session-row ${session.id === state.selectedSessionId ? "active" : ""}`,
    }, [
      button,
      session.status === "running" ? renderStopSessionButton(state, session, onStopSession) : null,
    ]);
  }));
}

function renderWorkspaceFileTree(state, onToggleWorkspaceFileDir, onSelectWorkspaceFile) {
  if (!state.selectedWorkspaceId) {
    return createElement("p", {className: "empty"}, "Select a workspace to view files.");
  }

  if (state.workspaceFilesWorkspaceId !== state.selectedWorkspaceId) {
    return createElement("p", {className: "empty"}, "Refresh files for this workspace.");
  }

  if (state.workspaceFilesError) {
    return createElement("p", {className: "file-error"}, state.workspaceFilesError);
  }

  if (!state.workspaceFiles.length) {
    return createElement("p", {className: "empty"}, "No files synced yet.");
  }

  const tree = buildFileTree(state.workspaceFiles);
  return createElement("div", {className: "file-tree"}, [
    ...renderFileNodes(tree.children, {
      expandedPaths: state.expandedFilePaths,
      onSelectWorkspaceFile,
      onToggleWorkspaceFileDir,
      selectedPath: state.selectedWorkspaceFilePath,
    }),
    ...renderFiles(tree.files, 0, {
      onSelectWorkspaceFile,
      selectedPath: state.selectedWorkspaceFilePath,
    }),
    state.workspaceFilesTruncated ?
      createElement("p", {className: "empty"}, "Showing first 500 files.") :
      null,
  ]);
}

function buildFileTree(files) {
  const root = {children: new Map(), files: [], name: "", path: ""};
  for (const entry of files) {
    const parts = String(entry.path || "").split("/").filter(Boolean);
    if (!parts.length) continue;
    let current = root;
    const folderParts = entry.type === "directory" ? parts : parts.slice(0, -1);
    folderParts.forEach((part) => {
      const path = current.path ? `${current.path}/${part}` : part;
      if (!current.children.has(part)) {
        current.children.set(part, {children: new Map(), files: [], name: part, path});
      }
      current = current.children.get(part);
    });
    if (entry.type !== "directory") {
      current.files.push(entry);
    }
  }
  return root;
}

function renderFileNodes(children, options, depth = 0) {
  const folders = Array.from(children.values())
      .sort((left, right) => left.name.localeCompare(right.name));
  return folders.flatMap((folder) => {
    const expanded = options.expandedPaths.has(folder.path);
    const button = createElement("button", {
      className: "file-row folder-row",
      style: `--depth: ${depth}`,
      title: folder.path,
      type: "button",
    }, [
      renderIcon(expanded ? ChevronDown : ChevronRight),
      renderIcon(expanded ? FolderOpen : Folder),
      createElement("span", {className: "file-name"}, folder.name),
      createElement("span", {className: "file-count"}, String(countFolderFiles(folder))),
    ]);
    button.addEventListener("click", () => options.onToggleWorkspaceFileDir(folder.path));

    if (!expanded) return [button];
    return [
      button,
      ...renderFileNodes(folder.children, options, depth + 1),
      ...renderFiles(folder.files, depth + 1, options),
    ];
  });
}

function renderFiles(files, depth, options) {
  return files
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((file) => {
        const button = createElement("button", {
          className: `file-row ${file.path === options.selectedPath ? "active" : ""}`,
          style: `--depth: ${depth}`,
          title: `${file.path}${file.updatedAt ? `\nUpdated ${formatDate(file.updatedAt)}` : ""}`,
          type: "button",
        }, [
          createElement("span", {className: "file-spacer"}),
          renderIcon(FileText),
          createElement("span", {className: "file-name"}, file.name),
          createElement("span", {className: "file-size"}, formatBytes(file.size)),
        ]);
        button.addEventListener("click", () => options.onSelectWorkspaceFile(file.path));
        return button;
      });
}

function countFolderFiles(folder) {
  return folder.files.length +
    Array.from(folder.children.values()).reduce((total, child) => total + countFolderFiles(child), 0);
}

function renderStopSessionButton(state, session, onStopSession) {
  const button = createElement("button", {
    ariaLabel: `Stop ${session.name}`,
    className: "session-stop-button secondary",
    disabled: state.busy,
    title: `Stop ${session.name}`,
    type: "button",
  }, renderIcon(SquareStop));
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onStopSession(session.id);
  });

  return button;
}

function renderWorkspaceHeader(workspace) {
  if (!workspace) {
    return createElement("div", {}, [
      createElement("h1", {}, "Create a workspace"),
      createElement("p", {className: "subtle"}, "A workspace owns the storage prefix shared by its sessions."),
    ]);
  }

  return createElement("div", {}, [
    createElement("h1", {}, workspace.name),
    createElement("p", {className: "subtle"}, workspaceSourceSummary(workspace)),
  ]);
}

function renderGitStatusPanel(session, gitStatus, handlers = {}) {
  const status = gitStatus || {
    loading: false,
    error: "",
    unavailable: false,
    data: null,
    actionMessage: "",
    commitMessage: "",
    canOpenPr: false,
  };
  const data = status.data || null;
  const title = session && session.name ? `Git status · ${session.name}` : "Git status";
  const pullButton = createElement("button", {
    className: "secondary",
    disabled: !handlers.onPullGit || status.loading,
    type: "button",
  }, status.loading ? "Loading..." : "Pull");
  if (handlers.onPullGit) {
    pullButton.addEventListener("click", () => handlers.onPullGit(session.id));
  }
  const pushButton = createElement("button", {
    className: "secondary",
    disabled: !handlers.onPushGit || status.loading || !data || data.git === false,
    type: "button",
  }, "Push");
  if (handlers.onPushGit) {
    pushButton.addEventListener("click", () => handlers.onPushGit(session.id));
  }
  const openPrButton = createElement("button", {
    className: "secondary",
    disabled: !handlers.onOpenPullRequest || status.loading || !status.canOpenPr,
    type: "button",
  }, "Open PR");
  if (handlers.onOpenPullRequest) {
    openPrButton.addEventListener("click", () => handlers.onOpenPullRequest(session.id));
  }

  let body;
  if (status.loading) {
    body = createElement("p", {className: "empty"}, "Loading Git status...");
  } else if (status.error) {
    body = createElement("p", {className: "empty"}, status.error);
  } else if (status.unavailable || !data || data.git === false) {
    body = createElement("p", {className: "empty"}, data && data.reason === "not_git_workspace" ?
      "This workspace is not Git-backed." :
      "Git status is unavailable.");
  } else {
    body = createElement("div", {className: "git-status-body"}, [
      createElement("div", {className: "details git-status-details"}, [
        metric("Branch", data.branch || ""),
        metric("Commit", data.commit ? data.commit.slice(0, 7) : ""),
        metric("Ahead", formatGitCount(data.ahead)),
        metric("Behind", formatGitCount(data.behind)),
        metric("Dirty", formatGitDirtySummary(data.dirty)),
        metric("Conflicted", data.conflicted ? "Yes" : "No"),
      ]),
      renderGitFileList(data.files || [], status.loading, handlers),
    ]);
  }

  const commitInput = createElement("input", {
    autocomplete: "off",
    disabled: status.loading || !data || data.git === false,
    placeholder: "Commit message",
    type: "text",
    value: status.commitMessage || "",
  });
  if (handlers.onUpdateGitCommitMessage) {
    commitInput.addEventListener("input", () => handlers.onUpdateGitCommitMessage(commitInput.value));
  }
  const commitButton = createElement("button", {
    disabled: status.loading || !handlers.onCommitGit || !data || data.git === false ||
      !status.commitMessage || !status.commitMessage.trim() || !(data.dirty && data.dirty.staged),
    type: "button",
  }, "Commit");
  if (handlers.onCommitGit) {
    commitButton.addEventListener("click", () => handlers.onCommitGit(session.id));
  }

  return createElement("section", {className: "git-status-panel"}, [
    createElement("div", {className: "drawer-section-heading"}, [
      createElement("h3", {}, title),
      createElement("div", {className: "git-status-actions"}, [
        createElement("span", {className: "pill"}, data && data.git ? "Git" : status.unavailable ? "Unavailable" : "Loading"),
        pullButton,
        pushButton,
        openPrButton,
      ]),
    ]),
    status.actionMessage ? createElement("p", {className: "subtle"}, status.actionMessage) : null,
    body,
    data && data.git ? createElement("div", {className: "git-commit-form"}, [
      commitInput,
      commitButton,
    ]) : null,
  ]);
}

function renderGitFileList(files, busy, handlers) {
  if (!files.length) {
    return createElement("p", {className: "subtle"}, "No changed files.");
  }

  return createElement("div", {className: "git-file-list"}, files.map((file) => {
    const actions = [];
    if (file.unstaged || file.untracked || file.conflicted) {
      const stageButton = createElement("button", {
        className: "secondary",
        disabled: busy || !handlers.onStageGitPath,
        type: "button",
      }, "Stage");
      if (handlers.onStageGitPath) {
        stageButton.addEventListener("click", () => handlers.onStageGitPath(file.path));
      }
      actions.push(stageButton);
    }
    if (file.staged) {
      const unstageButton = createElement("button", {
        className: "secondary",
        disabled: busy || !handlers.onUnstageGitPath,
        type: "button",
      }, "Unstage");
      if (handlers.onUnstageGitPath) {
        unstageButton.addEventListener("click", () => handlers.onUnstageGitPath(file.path));
      }
      actions.push(unstageButton);
    }

    return createElement("div", {className: "git-file-row"}, [
      createElement("div", {className: "git-file-meta"}, [
        createElement("strong", {}, file.path || ""),
        createElement("span", {className: "subtle"}, formatGitFileStatus(file)),
      ]),
      createElement("div", {className: "git-file-actions"}, actions),
    ]);
  }));
}

function formatGitFileStatus(file) {
  if (!file) return "";
  const parts = [];
  if (file.conflicted) parts.push("conflicted");
  if (file.untracked) parts.push("untracked");
  if (file.staged) parts.push("staged");
  if (file.unstaged) parts.push("unstaged");
  return parts.join(" · ") || "changed";
}

function formatGitCount(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return String(value);
}

function formatGitDirtySummary(dirty) {
  if (!dirty) return "—";
  const parts = [];
  if (dirty.staged) parts.push(`${dirty.staged} staged`);
  if (dirty.modified) parts.push(`${dirty.modified} modified`);
  if (dirty.deleted) parts.push(`${dirty.deleted} deleted`);
  if (dirty.untracked) parts.push(`${dirty.untracked} untracked`);
  if (dirty.conflicted) parts.push(`${dirty.conflicted} conflicted`);
  return parts.length ? parts.join(", ") : "Clean";
}

function workspaceSourceSummary(workspace) {
  if (!workspace) return "";
  const source = workspace.source || {type: "blank"};
  if (source.type !== "github") {
    return workspace.storagePrefix || "";
  }

  const repo = [source.owner, source.repo].filter(Boolean).join("/") || "GitHub repo";
  const branch = source.resolvedBranch || source.requestedBranch || "main";
  const sha = (source.resolvedCommit || source.requestedCommit || "").slice(0, 7);
  return [repo, branch, sha ? sha : null].filter(Boolean).join(" · ");
}

function renderSessionForm({state, onCreateSession}) {
  const nameInput = createElement("input", {
    autocomplete: "off",
    name: "name",
    placeholder: "shell",
    required: true,
  });
  const cpuSelect = renderSelect("cpu", cpuOptions, "1");
  const memorySelect = renderSelect("memory", memoryOptions, "1Gi", formatMemory);
  const imageSelect = renderImageSelect();

  const form = createElement("form", {className: "toolbar"}, [
    createElement("label", {}, [createElement("span", {}, "Name"), nameInput]),
    createElement("label", {}, [createElement("span", {}, "Container image"), imageSelect]),
    createElement("label", {}, [createElement("span", {}, "CPU"), cpuSelect]),
    createElement("label", {}, [createElement("span", {}, "Memory"), memorySelect]),
    createElement("button", {disabled: state.busy, type: "submit"}, "Create session"),
  ]);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    onCreateSession({
      name: nameInput.value.trim() || "Terminal session",
      image: imageSelect.value,
      cpu: cpuSelect.value,
      memory: memorySelect.value,
    });
  });
  return form;
}

function renderSessionModal({state, onCloseSessionModal, onCreateSession}) {
  const form = renderSessionForm({state, onCreateSession});
  const panel = createElement("section", {
    "aria-labelledby": "session-modal-title",
    "aria-modal": "true",
    className: "modal-panel",
    role: "dialog",
  }, [
    createElement("div", {className: "modal-heading"}, [
      createElement("h2", {id: "session-modal-title"}, "New session"),
      createElement("button", {
        ariaLabel: "Close",
        className: "icon-button close-button secondary",
        type: "button",
      }, "+"),
    ]),
    form,
  ]);

  panel.querySelector(".icon-button").addEventListener("click", onCloseSessionModal);

  const overlay = createElement("div", {className: "modal-backdrop"}, [panel]);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) onCloseSessionModal();
  });
  return overlay;
}

function renderPullRequestModal({state, onClosePullRequest, onUpdatePullRequestForm, onSubmitPullRequest}) {
  const formState = state.pullRequestForm || {
    title: "",
    body: "",
    branchDescription: "",
    draft: false,
    error: "",
  };
  const branchInput = createElement("input", {
    autocomplete: "off",
    placeholder: "fix-login-timeout",
    type: "text",
    value: formState.branchDescription || "",
  });
  branchInput.addEventListener("input", () => onUpdatePullRequestForm({branchDescription: branchInput.value}));

  const titleInput = createElement("input", {
    autocomplete: "off",
    placeholder: "Leave blank to use the first commit message",
    type: "text",
    value: formState.title || "",
  });
  titleInput.addEventListener("input", () => onUpdatePullRequestForm({title: titleInput.value}));

  const bodyInput = createElement("textarea", {rows: 10}, formState.body || "");
  bodyInput.value = formState.body || "";
  bodyInput.addEventListener("input", () => onUpdatePullRequestForm({body: bodyInput.value}));

  const draftInput = createElement("input", {
    checked: Boolean(formState.draft),
    type: "checkbox",
  });
  draftInput.addEventListener("change", () => onUpdatePullRequestForm({draft: draftInput.checked}));

  const closeButton = createElement("button", {
    className: "icon-button secondary",
    type: "button",
    ariaLabel: "Close pull request dialog",
  }, renderIcon(X));
  closeButton.addEventListener("click", onClosePullRequest);

  const panel = createElement("section", {
    className: "modal-panel pull-request-panel",
    role: "dialog",
    ariaModal: "true",
  }, [
    createElement("div", {className: "modal-heading"}, [
      createElement("h2", {}, "Open pull request"),
      closeButton,
    ]),
    createElement("p", {className: "subtle"}, "If the current branch is the default branch, a new mapache/<description> branch will be created before opening the PR."),
    formState.error ? createElement("div", {className: "error"}, formState.error) : null,
    createElement("div", {className: "modal-form"}, [
      createElement("label", {}, [
        createElement("span", {}, "Working branch description"),
        branchInput,
      ]),
      createElement("label", {}, [
        createElement("span", {}, "PR title"),
        titleInput,
      ]),
      createElement("label", {}, [
        createElement("span", {}, "PR body"),
        bodyInput,
      ]),
      createElement("label", {className: "checkbox-row"}, [
        draftInput,
        createElement("span", {}, "Open as draft"),
      ]),
    ]),
    createElement("div", {className: "toolbar"}, [
      createElement("div"),
      createElement("div", {className: "session-actions"}, [
        createElement("button", {
          className: "secondary",
          type: "button",
        }, "Cancel"),
        createElement("button", {type: "button"}, "Open PR"),
      ]),
    ]),
  ]);
  const [cancelButton, submitButton] = panel.querySelectorAll(".session-actions button");
  cancelButton.addEventListener("click", onClosePullRequest);
  submitButton.addEventListener("click", onSubmitPullRequest);

  const overlay = createElement("div", {className: "modal-backdrop"}, [panel]);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) onClosePullRequest();
  });
  return overlay;
}

function renderFileEditorModal({
  state,
  onCloseFileEditor,
  onSaveFileEditor,
  onUpdateFileEditorContent,
}) {
  const editor = state.fileEditor;
  const language = languageForPath(editor.path);
  const textarea = createElement("textarea", {
    autocapitalize: "off",
    autocomplete: "off",
    autocorrect: "off",
    className: "file-editor-input",
    disabled: editor.loading || editor.saving,
    spellcheck: false,
    value: editor.content,
  });
  const highlight = createElement("pre", {
    ariaHidden: "true",
    className: "file-editor-highlight",
  }, renderHighlightedCode(editor.content, language));

  textarea.addEventListener("input", () => {
    onUpdateFileEditorContent(textarea.value);
    replaceChildren(highlight, createElement("span", {}, renderHighlightedCode(
        textarea.value,
        language,
    )));
  });
  textarea.addEventListener("scroll", () => {
    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
  });

  const saveButton = createElement("button", {
    className: "file-editor-save",
    disabled: editor.loading || editor.saving,
    type: "button",
  }, [
    renderIcon(Save),
    createElement("span", {}, editor.saving ? "Saving" : "Save"),
  ]);
  saveButton.addEventListener("click", () => onSaveFileEditor(textarea.value));

  const closeButton = createElement("button", {
    ariaLabel: "Close editor",
    className: "icon-button secondary",
    title: "Close editor",
    type: "button",
  }, renderIcon(X));
  closeButton.addEventListener("click", onCloseFileEditor);

  const body = editor.loading ?
    createElement("div", {className: "file-editor-status"}, "Loading file...") :
    createElement("div", {className: "file-editor-stack"}, [
      highlight,
      textarea,
    ]);

  const panel = createElement("section", {
    "aria-labelledby": "file-editor-title",
    "aria-modal": "true",
    className: "modal-panel file-editor-panel",
    role: "dialog",
  }, [
    createElement("div", {className: "modal-heading"}, [
      createElement("div", {className: "file-editor-title"}, [
        createElement("h2", {id: "file-editor-title"}, editor.name || "File"),
        createElement("span", {}, editor.path),
      ]),
      closeButton,
    ]),
    editor.error ? createElement("div", {className: "error"}, editor.error) : null,
    body,
    createElement("div", {className: "file-editor-actions"}, [
      editor.updatedAt ?
        createElement("span", {className: "subtle"}, `Updated ${formatDate(editor.updatedAt)}`) :
        createElement("span", {className: "subtle"}, ""),
      saveButton,
    ]),
  ]);

  const overlay = createElement("div", {className: "modal-backdrop"}, [panel]);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) onCloseFileEditor();
  });
  return overlay;
}

function renderSessionList(state, {onSelectSession}) {
  if (!state.selectedWorkspaceId) return null;
  if (!state.sessions.length) {
    return createElement("div", {className: "list"}, [
      createElement("p", {className: "empty"}, "No sessions in this workspace."),
    ]);
  }

  return createElement("div", {className: "list"}, state.sessions.map((session) => {
    const button = createElement("button", {
      className: `row ${session.id === state.selectedSessionId ? "active" : ""}`,
      type: "button",
    }, [
      createElement("span", {className: "session-title"}, [
        createElement("span", {}, session.name),
        createElement("span", {className: "pill"}, session.status),
      ]),
      createElement("span", {className: "subtle"}, `${session.resources.cpu} CPU / ${session.resources.memory}`),
    ]);
    button.addEventListener("click", () => onSelectSession(session.id));
    return button;
  }));
}

function renderSessionDetail(session, {
  state,
  onResizeSession,
  onRestartSession,
  onPullGit,
  onPushGit,
  onStageGitPath,
  onUnstageGitPath,
  onUpdateGitCommitMessage,
  onCommitGit,
  onOpenPullRequest,
}) {
  const cpuSelect = renderSelect("resizeCpu", cpuOptions, session.resources.cpu);
  const memorySelect = renderSelect(
      "resizeMemory",
      memoryOptions,
      session.resources.memory,
      formatMemory,
  );

  const resizeButton = createElement("button", {
    disabled: state.busy,
    type: "button",
  }, "Resize");
  resizeButton.addEventListener("click", () => onResizeSession(session.id, {
    cpu: cpuSelect.value,
    memory: memorySelect.value,
  }));

  const restartButton = createElement("button", {
    className: "secondary",
    disabled: state.busy,
    type: "button",
  }, "Restart");
  restartButton.addEventListener("click", () => onRestartSession(session.id));

  return createElement("div", {className: "session-detail"}, [
    createElement("div", {className: "terminal-shell"}, [
      session.serviceUrl ?
        createElement("iframe", {
          allow: "clipboard-read; clipboard-write",
          src: session.serviceUrl,
          title: `Terminal ${session.name}`,
        }) :
        createElement("div", {className: "terminal-placeholder"}, [
          createElement("p", {}, [
            "Cloud Run URL is not ready.",
            createElement("br"),
            createElement("code", {}, session.lastError || session.status),
          ]),
        ]),
    ]),
    createElement("div", {className: "toolbar"}, [
      createElement("label", {}, [createElement("span", {}, "CPU"), cpuSelect]),
      createElement("label", {}, [createElement("span", {}, "Memory"), memorySelect]),
      createElement("div", {className: "session-actions"}, [
        resizeButton,
        restartButton,
      ]),
    ]),
    createElement("div", {className: "details"}, [
      metric("Status", session.status),
      metric("Region", session.region || ""),
      metric("Service", session.serviceId || ""),
      metric("Updated", formatDate(session.updatedAt)),
    ]),
    renderGitStatusPanel(session, state.gitStatus, {
      onPullGit,
      onPushGit,
      onStageGitPath,
      onUnstageGitPath,
      onUpdateGitCommitMessage,
      onCommitGit,
      onOpenPullRequest,
    }),
  ]);
}

function renderSelect(name, options, selectedValue, formatter = (value) => value) {
  return createElement("select", {name}, options.map((value) => createElement("option", {
    selected: value === selectedValue,
    value,
  }, formatter(value))));
}

function renderImageSelect() {
  return createElement("select", {name: "image"}, sessionImages.map((image) => createElement("option", {
    selected: image === sessionImages[0],
    value: image.value,
  }, image.label)));
}

function metric(label, value) {
  return createElement("div", {className: "metric"}, [
    createElement("span", {}, label),
    createElement("strong", {}, value || "pending"),
  ]);
}

function languageForPath(path) {
  const extension = String(path || "").split(".").pop().toLowerCase();
  if (["js", "mjs", "cjs"].includes(extension)) return "js";
  if (["json"].includes(extension)) return "json";
  if (["css"].includes(extension)) return "css";
  if (["html", "htm", "xml"].includes(extension)) return "markup";
  if (["md", "markdown"].includes(extension)) return "markdown";
  if (["py"].includes(extension)) return "python";
  if (["sh", "bash", "zsh"].includes(extension)) return "shell";
  if (["yaml", "yml"].includes(extension)) return "yaml";
  return "text";
}

function renderHighlightedCode(code, language) {
  const lines = String(code || "").split("\n");
  return lines.flatMap((line, index) => [
    ...highlightLine(line, language),
    index < lines.length - 1 ? "\n" : "",
  ]);
}

function highlightLine(line, language) {
  if (!line) return [""];

  const commentStart = findCommentStart(line, language);
  const codePart = commentStart >= 0 ? line.slice(0, commentStart) : line;
  const commentPart = commentStart >= 0 ? line.slice(commentStart) : "";
  const nodes = tokenizeCodePart(codePart, language);
  if (commentPart) {
    nodes.push(createElement("span", {className: "token-comment"}, commentPart));
  }
  return nodes;
}

function findCommentStart(line, language) {
  const markers = language === "markup" ?
    ["<!--"] :
    language === "css" ?
      ["/*"] :
      ["//", "#"];

  let inString = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inString) {
      if (char === "\\" && index + 1 < line.length) {
        index += 1;
      } else if (char === inString) {
        inString = "";
      }
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      inString = char;
      continue;
    }
    const marker = markers.find((item) => line.startsWith(item, index));
    if (marker) return index;
  }
  return -1;
}

function tokenizeCodePart(line, language) {
  const keywordPattern = keywordRegex(language);
  const tokenPattern = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|[A-Za-z_$][\w$-]*)(\s*:)?/g;
  const nodes = [];
  let cursor = 0;
  let match;

  while ((match = tokenPattern.exec(line))) {
    if (match.index > cursor) nodes.push(line.slice(cursor, match.index));
    const token = match[1];
    const suffix = match[2] || "";
    let className = "";
    if (/^["'`]/.test(token)) {
      className = suffix && language === "json" ? "token-key" : "token-string";
    } else if (/^\d/.test(token)) {
      className = "token-number";
    } else if (keywordPattern && keywordPattern.test(token)) {
      className = "token-keyword";
    }
    nodes.push(className ? createElement("span", {className}, token) : token);
    if (suffix) nodes.push(suffix);
    cursor = tokenPattern.lastIndex;
  }

  if (cursor < line.length) nodes.push(line.slice(cursor));
  return nodes;
}

function keywordRegex(language) {
  const groups = {
    css: /^(align-items|background|border|color|display|font|gap|grid|height|margin|padding|position|width)$/,
    js: /^(async|await|break|case|catch|const|continue|default|else|export|for|from|function|if|import|let|new|null|return|throw|true|false|try|while)$/,
    markdown: /^(TODO|NOTE|true|false|null)$/,
    markup: /^(body|button|div|form|head|html|input|label|main|meta|script|section|span|style|title)$/,
    python: /^(and|as|class|def|elif|else|except|False|for|from|if|import|in|None|not|or|return|True|try|while|with)$/,
    shell: /^(case|do|done|elif|else|esac|fi|for|function|if|in|then|while)$/,
    yaml: /^(true|false|null)$/,
  };
  return groups[language] || null;
}

function formatMemory(value) {
  return value.replace("Gi", " GiB");
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const amount = bytes / (1024 ** index);
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

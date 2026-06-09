import {createElement as createLucideIcon, Menu, PanelLeftClose} from "lucide";
import {createElement, formatDate, replaceChildren} from "./utils.js";
import {sessionImages} from "../config/sessionImages.js";

const cpuOptions = ["1", "2", "4"];
const memoryOptions = ["1Gi", "2Gi", "4Gi", "8Gi"];

export function renderAuthScreen(root, handlers) {
  const signInButton = createElement("button", {type: "button"}, "Sign in with Google");
  signInButton.addEventListener("click", handlers.onSignIn);

  replaceChildren(root, createElement("div", {className: "auth"}, [
    createElement("section", {className: "auth-panel"}, [
      createElement("h1", {}, "Pi Agents Cloud"),
      createElement("p", {}, "Sign in to manage cloud terminal sessions."),
      signInButton,
    ]),
  ]));
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
      createElement("h1", {}, "Pi Agents Cloud"),
    ]),
    createElement("div", {className: "userbar"}, [
      createElement("span", {}, state.user.email || state.user.uid),
      refreshButton,
      signOutButton,
    ]),
  ]);
}

function renderSidebar(props) {
  const {
    state,
    onCreateWorkspace,
    onOpenSessionModal,
    onSelectSession,
    onSelectWorkspace,
    onToggleDrawer,
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
  const form = createElement("form", {className: "form-row"}, [
    createElement("label", {}, [
      createElement("span", {}, "Workspace"),
      nameInput,
    ]),
    createElement("button", {
      disabled: state.busy,
      type: "submit",
    }, "Create"),
  ]);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    onCreateWorkspace({name: nameInput.value.trim() || "Default workspace"});
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
        createElement("h3", {}, "Sessions"),
        createSessionButton(state, onOpenSessionModal),
      ]),
      renderDrawerSessionList(state, onSelectSession),
    ]),
  ]);
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

function renderWorkspaceRow(workspace, isActive, busy, onSelectWorkspace, onOpenSessionModal) {
  const selectButton = createElement("button", {
    className: "workspace-select",
    type: "button",
  }, [
    createElement("span", {className: "row-title"}, [
      createElement("span", {}, workspace.name),
      createElement("span", {className: "pill"}, workspace.id.slice(0, 5)),
    ]),
    createElement("span", {className: "subtle"}, workspace.storagePrefix || ""),
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

function renderDrawerSessionList(state, onSelectSession) {
  if (!state.selectedWorkspaceId) {
    return createElement("p", {className: "empty"}, "Select a workspace to view sessions.");
  }

  if (!state.sessions.length) {
    return createElement("p", {className: "empty"}, "No sessions in this workspace.");
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

function renderWorkspaceHeader(workspace) {
  if (!workspace) {
    return createElement("div", {}, [
      createElement("h1", {}, "Create a workspace"),
      createElement("p", {className: "subtle"}, "A workspace owns the storage prefix shared by its sessions."),
    ]);
  }

  return createElement("div", {}, [
    createElement("h1", {}, workspace.name),
    createElement("p", {className: "subtle"}, workspace.storagePrefix || ""),
  ]);
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

function renderSessionDetail(session, {state, onResizeSession, onRestartSession}) {
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

function formatMemory(value) {
  return value.replace("Gi", " GiB");
}

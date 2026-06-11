import {createElement} from "./utils.js";
import {createElement as createLucideIcon, X} from "lucide";

export function renderWorkspaceModal(props) {
  const {onClose, onCreateWorkspace, onConnectGithub} = props;
  const repoPicker = props.repoPicker || {loading: false, error: "", repos: [], attempted: false};

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

  const form = createElement("form", {className: "modal-form"}, [
    createElement("label", {}, [
      createElement("span", {}, "Workspace Name"),
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
    createElement("button", {
      type: "submit",
      className: "primary",
    }, "Create Workspace"),
  ]);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const source = formData.get("workspaceSource");
    onCreateWorkspace({
      name: formData.get("name"),
      source: source,
      repoUrl: formData.get("repoUrl"),
      branch: formData.get("branch"),
    });
  });

  const panel = createElement("section", {
    "aria-labelledby": "workspace-modal-title",
    "aria-modal": "true",
    className: "modal-panel",
    role: "dialog",
  }, [
    createElement("div", {className: "modal-heading"}, [
      createElement("h2", {id: "workspace-modal-title"}, "Create Workspace"),
      createElement("button", {
        ariaLabel: "Close",
        className: "icon-button close-button secondary",
        type: "button",
      }, createLucideIcon(X)),
    ]),
    form,
  ]);

  panel.querySelector(".close-button").addEventListener("click", onClose);

  const overlay = createElement("div", {className: "modal-backdrop"}, [panel]);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) onClose();
  });

  return overlay;
}

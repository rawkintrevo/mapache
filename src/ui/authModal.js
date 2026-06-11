import {createElement} from "./utils.js";
import {createElement as createLucideIcon, X} from "lucide";
import {piAuthProviders} from "../config/piAuthProviders.js";

export function renderAddAuthModal({onClose, onSave}) {
  const providerSelect = createElement("select", {
    className: "auth-provider-select",
  }, piAuthProviders.map(p => createElement("option", {value: p.key}, p.label)));

  const keyInput = createElement("input", {
    type: "password",
    placeholder: "API Key",
    className: "auth-key-input",
  });

  const saveButton = createElement("button", {
    type: "button",
    className: "primary",
  }, "Save");

  saveButton.addEventListener("click", () => {
    onSave(providerSelect.value, keyInput.value);
    onClose();
  });

  const closeButton = createElement("button", {
    type: "button",
    className: "secondary",
  }, "Close");
  closeButton.addEventListener("click", onClose);

  const panel = createElement("section", {
    "aria-labelledby": "auth-modal-title",
    "aria-modal": "true",
    className: "modal-panel",
    role: "dialog",
  }, [
    createElement("div", {className: "modal-heading"}, [
      createElement("h2", {id: "auth-modal-title"}, "Add Authentication Provider"),
      createElement("button", {
        ariaLabel: "Close",
        className: "icon-button close-button secondary",
        type: "button",
      }, createLucideIcon(X)),
    ]),
    createElement("div", {className: "modal-form"}, [
      providerSelect,
      keyInput,
      createElement("div", {className: "modal-actions"}, [saveButton]),
    ]),
  ]);

  panel.querySelector(".close-button").addEventListener("click", onClose);

  const overlay = createElement("div", {className: "modal-backdrop"}, [panel]);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) onClose();
  });

  return overlay;
}

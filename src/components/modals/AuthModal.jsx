import {piAuthProviders} from "../../config/piAuthProviders.js";
import {ModalBackdrop} from "./ModalBackdrop.jsx";

export function AuthModal({onClose, onSave}) {
  return (
    <ModalBackdrop onClose={onClose}>
      <section aria-labelledby="auth-modal-title" aria-modal="true" className="modal-panel" role="dialog">
        <div className="modal-heading">
          <h2 id="auth-modal-title">Add Authentication Provider</h2>
          <button aria-label="Close" className="icon-button close-button secondary" type="button" onClick={onClose}>×</button>
        </div>
        <form
          className="modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            const formData = new FormData(event.currentTarget);
            onSave(formData.get("provider"), formData.get("apiKey"));
            onClose();
          }}
        >
          <select className="auth-provider-select" name="provider" defaultValue={piAuthProviders[0]?.key}>
            {piAuthProviders.map((provider) => <option key={provider.key} value={provider.key}>{provider.label}</option>)}
          </select>
          <input className="auth-key-input" name="apiKey" placeholder="API Key" type="password" />
          <div className="modal-actions"><button className="primary" type="submit">Save</button></div>
        </form>
      </section>
    </ModalBackdrop>
  );
}

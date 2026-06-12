import {X} from "lucide-react";
import {Button} from "../common/Button.jsx";
import {ModalBackdrop} from "./ModalBackdrop.jsx";

export function PullRequestModal({formState, onClose, onSubmit, onUpdate}) {
  const state = formState || {title: "", body: "", branchDescription: "", draft: false, error: ""};

  return (
    <ModalBackdrop onClose={onClose}>
      <section aria-modal="true" className="modal-panel pull-request-panel" role="dialog">
        <div className="modal-heading">
          <h2>Open pull request</h2>
          <Button aria-label="Close pull request dialog" icon={true} tooltip="Close pull request dialog" variant="secondary" onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        </div>
        <p className="subtle">If the current branch is the default branch, a new mapache/&lt;description&gt; branch will be created before opening the PR.</p>
        {state.error ? <div className="error">{state.error}</div> : null}
        <div className="modal-form">
          <label><span>Working branch description</span><input autoComplete="off" placeholder="fix-login-timeout" type="text" value={state.branchDescription || ""} onChange={(event) => onUpdate({branchDescription: event.target.value})} /></label>
          <label><span>PR title</span><input autoComplete="off" placeholder="Leave blank to use the first commit message" type="text" value={state.title || ""} onChange={(event) => onUpdate({title: event.target.value})} /></label>
          <label><span>PR body</span><textarea rows={10} value={state.body || ""} onChange={(event) => onUpdate({body: event.target.value})} /></label>
          <label className="checkbox-row"><input checked={Boolean(state.draft)} type="checkbox" onChange={(event) => onUpdate({draft: event.target.checked})} /><span>Open as draft</span></label>
        </div>
        <div className="toolbar">
          <div />
          <div className="session-actions">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={onSubmit}>Open PR</Button>
          </div>
        </div>
      </section>
    </ModalBackdrop>
  );
}

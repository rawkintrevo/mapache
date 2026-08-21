import {useEffect, useMemo, useState} from "react";
import {X} from "lucide-react";
import {Button} from "../common/Button.jsx";
import {ModalBackdrop} from "./ModalBackdrop.jsx";

export function PiModelsModal({modelState, onClose, onRefresh, onSave}) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(() => modelState.scopedModels || []);
  useEffect(() => setSelected(modelState.scopedModels || []), [modelState.scopedModels]);
  const models = modelState.models || [];
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query ? models.filter((model) => `${model.provider} ${model.model}`.toLowerCase().includes(query)) : models;
  }, [models, search]);
  const selectedSet = new Set(selected);

  function toggle(modelId) {
    setSelected((current) => current.includes(modelId) ? current.filter((id) => id !== modelId) : [...current, modelId]);
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <section aria-labelledby="pi-models-title" aria-modal="true" className="modal-panel pi-models-modal" role="dialog">
        <div className="modal-heading">
          <div>
            <h2 id="pi-models-title">Scoped models</h2>
            <p className="subtle">Choose the models Pi cycles through and shows in its scoped model picker.</p>
          </div>
          <Button aria-label="Close" icon={true} tooltip="Close" variant="secondary" onClick={onClose}><X aria-hidden="true" /></Button>
        </div>
        <label><span>Search models</span><input autoComplete="off" placeholder="Provider or model" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <div className="modal-actions">
          <Button disabled={modelState.loading || !filtered.length} variant="secondary" onClick={() => setSelected((current) => [...new Set([...current, ...filtered.map((model) => model.id)])])}>Select shown</Button>
          <Button disabled={modelState.loading || !selected.length} variant="secondary" onClick={() => setSelected([])}>Clear scope</Button>
          <Button disabled={modelState.loading} variant="secondary" onClick={onRefresh}>Refresh catalog</Button>
        </div>
        {modelState.loading ? <p className="empty">Loading authenticated Pi models…</p> : null}
        {modelState.error ? <p className="error">{modelState.error}</p> : null}
        {!modelState.loading && !filtered.length ? <p className="empty">No authenticated models match this search.</p> : (
          <div className="pi-models-list">
            {filtered.map((model) => (
              <label className="pi-model-row" key={model.id}>
                <input checked={selectedSet.has(model.id)} type="checkbox" onChange={() => toggle(model.id)} />
                <span><strong>{model.model}</strong><small>{model.provider} · {model.context} context{model.reasoning ? " · reasoning" : ""}{model.images ? " · images" : ""}</small></span>
              </label>
            ))}
          </div>
        )}
        <p className="subtle">An empty scope leaves all authenticated models available. Restart Pi inside the terminal after saving to apply the new cycle list immediately.</p>
        <div className="modal-actions">
          <Button disabled={modelState.loading || modelState.saving} onClick={() => onSave(selected)}>{modelState.saving ? "Saving…" : "Save scope"}</Button>
          <Button disabled={modelState.saving} variant="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </section>
    </ModalBackdrop>
  );
}

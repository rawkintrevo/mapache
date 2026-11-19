import {useEffect, useMemo, useState} from "react";
import {bundledModelCatalog, loadRemoteModelCatalog} from "../../config/remoteModelCatalog.js";
import {piAuthProviderLabel} from "../../config/piAuthProviders.js";

export function AutomationModelPicker({value, onChange, disabled = false}) {
  const providerId = value?.providerId || "";
  const modelId = value?.modelId || "";
  const [custom, setCustom] = useState(false);
  const [catalog, setCatalog] = useState(bundledModelCatalog);
  useEffect(() => {
    let active = true;
    // Vitest must keep this component deterministic and offline; production
    // and local browser sessions refresh the public Pi catalog automatically.
    if (import.meta.env.MODE === "test") return undefined;
    void loadRemoteModelCatalog().then((next) => {
      if (active) setCatalog(next);
    }).catch(() => {
      // The bundled catalog remains usable when pi.dev is unavailable.
    });
    return () => {
      active = false;
    };
  }, []);
  const providers = useMemo(() => Object.keys(catalog.providers).sort((a, b) => piAuthProviderLabel(a).localeCompare(piAuthProviderLabel(b))), [catalog]);
  const models = catalog.providers[providerId] || {};
  return (
    <fieldset className="automation-editor__model" disabled={disabled}>
      <legend>Automation model</legend>
      <p className="subtle" id="automation-model-help">Choose the model for this automation. The runner uses your saved provider credentials.</p>
      {custom ? (
        <div className="automation-editor__model-fields">
          <label>Provider ID<input autoComplete="off" maxLength={256} value={providerId} onChange={(event) => onChange({providerId: event.target.value, modelId: ""})} /></label>
          <label>Model ID<input autoComplete="off" maxLength={256} value={modelId} onChange={(event) => onChange({providerId, modelId: event.target.value})} /></label>
        </div>
      ) : (
        <div className="automation-editor__model-fields">
          <label>Provider
            <select aria-describedby="automation-model-help" value={providerId} onChange={(event) => onChange({providerId: event.target.value, modelId: ""})}>
              <option value="">Choose a provider</option>
              {providerId && !catalog.providers[providerId] ? <option value={providerId}>{providerId} (saved)</option> : null}
              {providers.map((provider) => <option key={provider} value={provider}>{piAuthProviderLabel(provider)}</option>)}
            </select>
          </label>
          <label>Model
            <select disabled={!providerId} value={modelId} onChange={(event) => onChange({providerId, modelId: event.target.value})}>
              <option value="">Choose a model</option>
              {modelId && !models[modelId] ? <option value={modelId}>{modelId} (saved)</option> : null}
              {Object.entries(models).map(([id, name]) => <option key={id} value={id}>{name === id ? name : `${name} (${id})`}</option>)}
            </select>
          </label>
        </div>
      )}
      <label className="automation-editor__switch"><input checked={custom} type="checkbox" onChange={(event) => setCustom(event.target.checked)} /> Enter custom provider and model IDs</label>
    </fieldset>
  );
}

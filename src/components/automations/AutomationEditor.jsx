import {useMemo} from "react";
import {Button} from "../common/Button.jsx";
import {inferScheduleMode, ScheduleControls, timezoneOptions, validateCronShape, validateTimezone} from "./ScheduleControls.jsx";
import "./AutomationEditor.css";

export function browserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function createAutomationDraft({automation = null, userTimezone = ""} = {}) {
  if (automation) {
    return {
      ...automation,
      prompt: automation.prompt || "",
      enabled: automation.enabled === true,
      allowParallelWithMain: automation.allowParallelWithMain !== false,
      timezone: automation.timezone || "UTC",
      cron: automation.cron || "0 9 * * *",
      missedRunPolicy: automation.missedRunPolicy || "skip",
      catchUpWindowMinutes: Number.isSafeInteger(automation.catchUpWindowMinutes) ? automation.catchUpWindowMinutes : 1440,
      retryPolicy: automation.retryPolicy || "none",
      maximumRetries: Number.isSafeInteger(automation.maximumRetries) ? automation.maximumRetries : 0,
      replaySafe: automation.replaySafe === true,
      scheduleMode: inferScheduleMode(automation.cron || ""),
    };
  }
  const timezone = userTimezone || browserTimezone();
  return {
    name: "",
    prompt: "",
    enabled: false,
    allowParallelWithMain: true,
    cron: "0 9 * * *",
    timezone,
    modelSelection: null,
    missedRunPolicy: "skip",
    catchUpWindowMinutes: 1440,
    retryPolicy: "none",
    maximumRetries: 0,
    replaySafe: false,
    scheduleMode: "daily",
  };
}

export function automationEditorErrors(draft = {}) {
  const errors = {};
  if (!String(draft.name || "").trim()) errors.name = "Add a name.";
  if (!String(draft.prompt || "").trim()) errors.prompt = "Add instructions for the automation.";
  const cronError = validateCronShape(draft.cron);
  if (cronError) errors.cron = cronError;
  const timezoneError = validateTimezone(draft.timezone);
  if (timezoneError) errors.timezone = timezoneError;
  const catchUpWindow = Number(draft.catchUpWindowMinutes ?? 1440);
  if (!["skip", "latest"].includes(String(draft.missedRunPolicy || "skip"))) {
    errors.missedRunPolicy = "Choose skip or latest.";
  }
  if (!Number.isSafeInteger(catchUpWindow) || catchUpWindow < 1 || catchUpWindow > 10080) {
    errors.catchUpWindowMinutes = "Use a catch-up window from 1 to 10080 minutes.";
  }
  const maximumRetries = Number(draft.maximumRetries ?? 0);
  if (!["none", "safe"].includes(String(draft.retryPolicy || "none"))) {
    errors.retryPolicy = "Choose no retries or safe retries.";
  }
  if (!Number.isSafeInteger(maximumRetries) || maximumRetries < 0 || maximumRetries > 2) {
    errors.maximumRetries = "Use between 0 and 2 retries.";
  }
  if (draft.retryPolicy === "safe" && draft.replaySafe !== true) {
    errors.replaySafe = "Acknowledge replay safety before enabling safe retries.";
  }
  return errors;
}

export function automationPayload(draft = {}) {
  const payload = {
    name: String(draft.name || "").trim(),
    prompt: String(draft.prompt || ""),
    enabled: draft.enabled === true,
    cron: String(draft.cron || "").trim(),
    timezone: String(draft.timezone || "").trim(),
    allowParallelWithMain: draft.allowParallelWithMain !== false,
    missedRunPolicy: draft.missedRunPolicy || "skip",
    catchUpWindowMinutes: Number(draft.catchUpWindowMinutes) || 1440,
    retryPolicy: draft.retryPolicy || "none",
    maximumRetries: Number(draft.maximumRetries) || 0,
    replaySafe: draft.replaySafe === true,
    ...(draft.modelSelection ? {modelSelection: draft.modelSelection} : {}),
    ...(draft.resources ? {resources: draft.resources} : {}),
  };
  if (draft.expectedRevision !== undefined && draft.expectedRevision !== null) payload.expectedRevision = draft.expectedRevision;
  return payload;
}

export function AutomationEditor({
  busy = false,
  conflict = null,
  draft,
  error = "",
  isCreating = false,
  modelConfigured,
  onCancel,
  onChange,
  onOpenModelSettings,
  onPreview,
  onPreviewResult,
  onSave,
  preview = null,
  previewError = "",
  previewLoading = false,
  storageReady = true,
  userTimezone = "",
}) {
  const form = draft || createAutomationDraft({userTimezone});
  const errors = useMemo(() => automationEditorErrors(form), [form]);
  const hasModel = modelConfigured === undefined ? Boolean(form.modelSelection?.modelId || form.modelSelection?.providerId) : modelConfigured;
  const editorTitle = isCreating ? "New automation" : "Edit automation";
  const update = (patch) => onChange?.({...form, ...patch});
  const previewUpdate = (cron) => update({cron});
  const submit = (event) => {
    event.preventDefault();
    if (Object.keys(errors).length) {
      onChange?.({...form, validationErrors: errors});
      return;
    }
    onSave?.(automationPayload({...form, enabled: storageReady && form.enabled === true}));
  };

  return (
    <section aria-labelledby="automation-editor-title" className="automation-editor">
      <div className="automation-editor__heading">
        <div>
          <h2 id="automation-editor-title">{editorTitle}</h2>
          <p className="subtle">Save a prompt and schedule for a fresh conversation in this workspace.</p>
        </div>
        <Button disabled={busy} variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
      {conflict ? <p className="automation-editor__conflict" role="alert">This automation changed elsewhere. Review the refreshed definition before saving again.</p> : null}
      <form onSubmit={submit}>
        <label>
          Name
          <input aria-describedby={errors.name ? "automation-name-error" : undefined} aria-invalid={Boolean(errors.name)} autoComplete="off" disabled={busy} value={form.name || ""} onChange={(event) => update({name: event.target.value})} />
          {errors.name ? <span className="field-error" id="automation-name-error">{errors.name}</span> : null}
        </label>
        <label>
          Instructions
          <textarea aria-describedby={errors.prompt ? "automation-prompt-error" : undefined} aria-invalid={Boolean(errors.prompt)} disabled={busy} rows={8} value={form.prompt || ""} onChange={(event) => update({prompt: event.target.value})} />
          {errors.prompt ? <span className="field-error" id="automation-prompt-error">{errors.prompt}</span> : null}
        </label>
        <div className="automation-editor__switches">
          <label className="automation-editor__switch"><input checked={form.enabled === true && storageReady} disabled={busy || !storageReady} type="checkbox" onChange={(event) => update({enabled: event.target.checked})} /> Enabled</label>
          <label className="automation-editor__switch"><input checked={form.allowParallelWithMain !== false} disabled={busy} type="checkbox" onChange={(event) => update({allowParallelWithMain: event.target.checked})} /> Allow running while main workspace is active</label>
        </div>
        {!storageReady ? <p className="automation-editor__storage-warning" role="status">Configure existing shared workspace storage before enabling or running automations. Disabled workflows can still be saved.</p> : null}
        <ScheduleControls
          cron={form.cron || ""}
          mode={form.scheduleMode || inferScheduleMode(form.cron)}
          onChange={previewUpdate}
          onModeChange={(scheduleMode) => update({scheduleMode})}
          onPreview={onPreview}
          onPreviewResult={onPreviewResult}
          preview={preview}
          previewError={previewError || errors.cron || errors.timezone}
          previewLoading={previewLoading}
          timezone={form.timezone || ""}
          userTimezone={userTimezone}
          onTimezoneChange={(timezone) => update({timezone})}
        />
        <fieldset className="automation-editor__recovery">
          <legend>Recovery</legend>
          <p className="subtle">These policies are saved with each definition. Existing and new automations default to skipping missed runs and making no automatic retries.</p>
          <label>
            Missed run policy
            <select aria-describedby={errors.missedRunPolicy ? "automation-missed-policy-error" : undefined} aria-invalid={Boolean(errors.missedRunPolicy)} disabled={busy} value={form.missedRunPolicy || "skip"} onChange={(event) => update({missedRunPolicy: event.target.value})}>
              <option value="skip">Skip missed runs</option>
              <option value="latest">Run the latest missed occurrence</option>
            </select>
            {errors.missedRunPolicy ? <span className="field-error" id="automation-missed-policy-error">{errors.missedRunPolicy}</span> : null}
          </label>
          <label>
            Catch-up window (minutes)
            <input aria-describedby={errors.catchUpWindowMinutes ? "automation-catch-up-window-error" : undefined} aria-invalid={Boolean(errors.catchUpWindowMinutes)} disabled={busy || form.missedRunPolicy !== "latest"} max="10080" min="1" step="1" type="number" value={form.catchUpWindowMinutes ?? 1440} onChange={(event) => update({catchUpWindowMinutes: event.target.value === "" ? "" : Number(event.target.value)})} />
            {errors.catchUpWindowMinutes ? <span className="field-error" id="automation-catch-up-window-error">{errors.catchUpWindowMinutes}</span> : null}
          </label>
          <label>
            Retry policy
            <select aria-describedby={errors.retryPolicy ? "automation-retry-policy-error" : undefined} aria-invalid={Boolean(errors.retryPolicy)} disabled={busy} value={form.retryPolicy || "none"} onChange={(event) => update({retryPolicy: event.target.value})}>
              <option value="none">No automatic retries</option>
              <option value="safe">Safe retries</option>
            </select>
            {errors.retryPolicy ? <span className="field-error" id="automation-retry-policy-error">{errors.retryPolicy}</span> : null}
          </label>
          <label>
            Maximum retries
            <input aria-describedby={errors.maximumRetries ? "automation-maximum-retries-error" : undefined} aria-invalid={Boolean(errors.maximumRetries)} disabled={busy || form.retryPolicy !== "safe"} max="2" min="0" step="1" type="number" value={form.maximumRetries ?? 0} onChange={(event) => update({maximumRetries: event.target.value === "" ? "" : Number(event.target.value)})} />
            {errors.maximumRetries ? <span className="field-error" id="automation-maximum-retries-error">{errors.maximumRetries}</span> : null}
          </label>
          <label className="automation-editor__acknowledgement">
            <input checked={form.replaySafe === true} disabled={busy || form.retryPolicy !== "safe"} type="checkbox" onChange={(event) => update({replaySafe: event.target.checked})} />
            I understand a safe retry can repeat publication or sends, and each attempt reads the current files.
          </label>
          {errors.replaySafe ? <span className="field-error" id="automation-replay-safe-error">{errors.replaySafe}</span> : null}
        </fieldset>
        {form.enabled === true && !hasModel ? (
          <div className="automation-editor__model-warning" role="status">
            <strong>Choose a model in main Agent settings before enabling this automation.</strong>
            {onOpenModelSettings ? <Button disabled={busy} variant="secondary" onClick={onOpenModelSettings}>Open Agent settings</Button> : null}
          </div>
        ) : null}
        <div className="automation-editor__actions">
          <Button disabled={busy} variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button disabled={busy} type="submit">{busy ? "Saving..." : isCreating ? "Create automation" : "Save automation"}</Button>
        </div>
      </form>
    </section>
  );
}

export {timezoneOptions};

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
    onSave?.(automationPayload(form));
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
          <label className="automation-editor__switch"><input checked={form.enabled === true} disabled={busy} type="checkbox" onChange={(event) => update({enabled: event.target.checked})} /> Enabled</label>
          <label className="automation-editor__switch"><input checked={form.allowParallelWithMain !== false} disabled={busy} type="checkbox" onChange={(event) => update({allowParallelWithMain: event.target.checked})} /> Allow running while main workspace is active</label>
        </div>
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
        {form.enabled === true && !hasModel ? (
          <div className="automation-editor__model-warning" role="status">
            <strong>Choose a model in main Agent settings before enabling this automation.</strong>
            <Button disabled={busy} variant="secondary" onClick={onOpenModelSettings}>Open Agent settings</Button>
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

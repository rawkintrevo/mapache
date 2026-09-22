import {useState} from "react";
import {render, screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe, expect, test, vi} from "vitest";
import {AutomationEditor, createAutomationDraft} from "./AutomationEditor.jsx";
import catalog from "../../config/automationModelCatalog.json";
import runner from "../../../session-runner/upstream/pi-web-ui/manifest.json";

function Editor({automation, workspace, onSave = vi.fn()}) {
  const [draft, setDraft] = useState(createAutomationDraft({
    automation: automation || {name: "Daily report", prompt: "Summarize files.", timezone: "UTC"}, workspace,
  }));
  return <AutomationEditor draft={draft} onChange={setDraft} onSave={onSave} />;
}

describe("automation model selection", () => {
  test("uses the runner's pinned model catalog", () => {
    expect(catalog.source.version).toBe(runner.piSdk.version);
    expect(catalog.providers.openai["gpt-4.1"]).toBeTruthy();
    expect(catalog.providers["github-cli"]).toBeUndefined();
  });

  test("selects a provider and model, enables, and saves the exact pair", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<Editor onSave={onSave} />);
    expect(screen.getByRole("checkbox", {name: "Enabled"})).toBeDisabled();
    await user.selectOptions(screen.getByRole("combobox", {name: "Provider"}), "openai");
    expect(screen.getByRole("checkbox", {name: "Enabled"})).toBeDisabled();
    await user.selectOptions(screen.getByRole("combobox", {name: "Model"}), "gpt-4.1");
    await user.click(screen.getByRole("checkbox", {name: "Enabled"}));
    await user.click(screen.getByRole("button", {name: "Save automation"}));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({enabled: true, modelSelection: {providerId: "openai", modelId: "gpt-4.1"}}));

    await user.selectOptions(screen.getByRole("combobox", {name: "Provider"}), "anthropic");
    expect(screen.getByRole("combobox", {name: "Model"})).toHaveValue("");
    expect(screen.getByRole("button", {name: "Save automation"})).toBeDisabled();
    // Disabling is always possible, including while changing an enabled definition's model.
    await user.click(screen.getByRole("checkbox", {name: "Enabled"}));
    expect(screen.getByRole("button", {name: "Save automation"})).toBeEnabled();
  });

  test("preserves unknown saved IDs and allows a custom replacement", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<Editor automation={{name: "Custom", prompt: "Report", modelSelection: {providerId: "private-provider", modelId: "private-model"}}} onSave={onSave} />);
    expect(screen.getByRole("combobox", {name: "Provider"})).toHaveValue("private-provider");
    expect(screen.getByRole("combobox", {name: "Model"})).toHaveValue("private-model");
    await user.click(screen.getByRole("button", {name: "Save automation"}));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({modelSelection: {providerId: "private-provider", modelId: "private-model"}}));
    await user.click(screen.getByRole("checkbox", {name: "Enter custom provider and model IDs"}));
    await user.clear(screen.getByRole("textbox", {name: "Model ID"}));
    await user.type(screen.getByRole("textbox", {name: "Model ID"}), " new-model ");
    await user.click(screen.getByRole("button", {name: "Save automation"}));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({modelSelection: {providerId: "private-provider", modelId: "new-model"}}));
  });

  test("shows inherited workspace defaults but does not fall back while editing an incomplete pair", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<Editor workspace={{modelSelection: {providerId: "openai", modelId: "gpt-4.1"}}} onSave={onSave} />);
    expect(screen.getByRole("combobox", {name: "Model"})).toHaveValue("gpt-4.1");
    await user.selectOptions(screen.getByRole("combobox", {name: "Provider"}), "");
    expect(screen.getByRole("checkbox", {name: "Enabled"})).toBeDisabled();
    await user.click(screen.getByRole("button", {name: "Save automation"}));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({enabled: false, modelSelection: null}));
  });
});

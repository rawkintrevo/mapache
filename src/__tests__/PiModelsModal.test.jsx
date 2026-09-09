import {render, screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe, expect, test, vi} from "vitest";
import {PiModelsModal} from "../components/modals/PiModelsModal.jsx";

describe("PiModelsModal", () => {
  test("filters the live catalog and saves selected model ids", async () => {
    const onSave = vi.fn();
    render(
      <PiModelsModal
        modelState={{
          loading: false,
          saving: false,
          error: "",
          scopedModels: ["openai/gpt-5.5"],
          models: [
            {id: "openai/gpt-5.5", provider: "openai", model: "gpt-5.5", context: "400K"},
            {id: "openai-codex/gpt-5.5", provider: "openai-codex", model: "gpt-5.5", context: "400K", reasoning: true},
          ],
        }}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
        onSave={onSave}
      />,
    );

    await userEvent.type(screen.getByLabelText("Search models"), "codex");
    await userEvent.click(screen.getByRole("checkbox", {name: /gpt-5.5/i}));
    await userEvent.click(screen.getByRole("button", {name: "Save scope"}));

    expect(onSave).toHaveBeenCalledWith(["openai/gpt-5.5", "openai-codex/gpt-5.5"]);
  });

  test("clears the scope to leave all authenticated models available", async () => {
    const onSave = vi.fn();
    render(
      <PiModelsModal
        modelState={{loading: false, saving: false, error: "", models: [], scopedModels: ["openai/gpt-5.5"]}}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
        onSave={onSave}
      />,
    );

    await userEvent.click(screen.getByRole("button", {name: "Clear scope"}));
    await userEvent.click(screen.getByRole("button", {name: "Save scope"}));
    expect(onSave).toHaveBeenCalledWith([]);
  });
});

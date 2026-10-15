import {render, screen, fireEvent, waitFor} from "@testing-library/react";
import {describe, it, expect, vi} from "vitest";
import {AuthModal} from "./AuthModal.jsx";
import {PiAuthManageModal} from "./PiAuthManageModal.jsx";

describe("custom provider credentials", () => {
  it("shows stable ID and endpoint fields and retains the dialog when saving fails", async () => {
    const onClose = vi.fn();
    const onSave = vi.fn().mockResolvedValue(false);
    render(<AuthModal piAuth={{selectedProvider: "openai-compatible", customProviderId: "custom-lab", baseUrl: "https://lab.example/v1", apiKey: "test"}} onClose={onClose} onSave={onSave} />);
    expect(screen.getByLabelText("Provider ID")).toHaveValue("custom-lab");
    expect(screen.getByLabelText("Server base URL")).toHaveValue("https://lab.example/v1");
    fireEvent.submit(screen.getByRole("button", {name: "Save"}).closest("form"));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
  });
  it("allows selecting two independent custom providers alongside OpenAI", () => {
    const entries = Object.fromEntries(["custom-lab", "custom-gpu", "openai"].map((providerKey) => [providerKey, {providerKey, label: providerKey}]));
    const onSave = vi.fn();
    render(<PiAuthManageModal session={{harnessId: "pi", authSelection: {providers: {}}}} piAuth={{entries}} onSave={onSave} />);
    for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", {name: "Save"}));
    expect(onSave).toHaveBeenCalledWith({harness: "pi", providers: {"custom-lab": "custom-lab", "custom-gpu": "custom-gpu", openai: "openai"}});
  });
});

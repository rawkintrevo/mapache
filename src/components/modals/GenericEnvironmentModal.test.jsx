import {render, screen} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";
import {GenericEnvironmentModal} from "./GenericEnvironmentModal.jsx";

describe("GenericEnvironmentModal", () => {
  it("keeps form and registered-key actions distinct and exposes session selection", () => {
    render(<GenericEnvironmentModal
      piAuth={{
        saving: false,
        environmentForm: {},
        environmentEntries: [{id: "env-1", name: "SERVICE_TOKEN", label: "Service token"}],
      }}
      selectedSession={{id: "session-1", name: "Agent", environmentEntryIds: ["env-1"]}}
      onClose={vi.fn()}
      onDelete={vi.fn()}
      onEdit={vi.fn()}
      onSave={vi.fn()}
      onToggleSelection={vi.fn()}
      onUpdate={vi.fn()}
    />);

    expect(screen.getByRole("button", {name: "Save key"}).parentElement).toHaveClass("generic-environment-form-actions");
    expect(screen.getByRole("button", {name: "Edit SERVICE_TOKEN"})).toBeVisible();
    expect(screen.getByRole("button", {name: "Delete SERVICE_TOKEN"})).toBeVisible();
    expect(screen.getByRole("checkbox", {name: "Use in Agent"})).toBeChecked();
  });
});

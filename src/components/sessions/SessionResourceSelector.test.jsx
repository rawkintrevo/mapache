import {render, screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {useState} from "react";
import {describe, expect, test} from "vitest";
import {SessionResourceSelector} from "./SessionResourceSelector.jsx";

function ResourceHarness({initial = {cpu: "1", memory: "2Gi"}}) {
  const [resources, setResources] = useState(initial);
  return <SessionResourceSelector cpu={resources.cpu} memory={resources.memory} onChange={setResources} />;
}

describe("SessionResourceSelector", () => {
  test("defaults to Small and shows the compute-only estimate", () => {
    render(<ResourceHarness />);

    expect(screen.getByRole("radio", {name: /Small/})).toBeChecked();
    expect(screen.getByText(/Small selection: \$0\.0792\/hr estimate/)).toBeInTheDocument();
    expect(screen.getByText(/Compute-only estimate/)).toBeInTheDocument();
  });

  test("changes presets and infers Custom after advanced editing", async () => {
    const user = userEvent.setup();
    render(<ResourceHarness />);

    await user.click(screen.getByRole("radio", {name: /Medium/}));
    expect(screen.getByRole("radio", {name: /Medium/})).toBeChecked();
    expect(screen.getByText(/Medium selection: \$0\.1584\/hr estimate/)).toBeInTheDocument();

    await user.click(screen.getByText("Advanced settings"));
    await user.selectOptions(screen.getByRole("combobox", {name: "CPU"}), "2");
    await user.selectOptions(screen.getByRole("combobox", {name: "Memory"}), "2Gi");
    expect(screen.getByRole("radio", {name: /Custom/})).toBeChecked();
    expect(screen.getByText(/Custom selection/)).toBeInTheDocument();
  });

  test("disables incompatible advanced pairs", async () => {
    const user = userEvent.setup();
    render(<ResourceHarness />);
    await user.click(screen.getByText("Advanced settings"));

    expect(screen.getByRole("option", {name: "8 GiB"})).toBeDisabled();
  });
});

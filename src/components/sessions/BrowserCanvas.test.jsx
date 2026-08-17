import {render, screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe, expect, test, vi} from "vitest";
import {BrowserCanvas} from "./BrowserCanvas.jsx";

describe("BrowserCanvas", () => {
  test("renders authenticated Chrome access in the session canvas", () => {
    render(<BrowserCanvas sessionName="Chrome smoke" url="https://runner.example/browser/?mapache_access=token" />);

    expect(screen.getByTitle("Chrome Chrome smoke")).toHaveAttribute(
        "src",
        "https://runner.example/browser/?mapache_access=token",
    );
  });

  test("opens the signed browser URL in a new tab", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const user = userEvent.setup();
    render(<BrowserCanvas sessionName="Chrome smoke" url="https://runner.example/browser/" />);

    await user.click(screen.getByRole("button", {name: "Open Chrome in new tab"}));
    expect(open).toHaveBeenCalledWith(
        "https://runner.example/browser/",
        "_blank",
        "noopener,noreferrer",
    );
    open.mockRestore();
  });

  test("explains when browser access is not ready", () => {
    render(<BrowserCanvas sessionName="Chrome smoke" url="" />);
    expect(screen.getByText("browser_access_unavailable")).toBeInTheDocument();
  });
});

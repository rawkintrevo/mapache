import {render, screen} from "@testing-library/react";
import {describe, expect, test} from "vitest";
import {BrowserCanvas} from "./BrowserCanvas.jsx";

describe("BrowserCanvas", () => {
  test("renders authenticated Chrome access in the session canvas", () => {
    render(<BrowserCanvas sessionName="Chrome smoke" url="https://runner.example/browser/?mapache_access=token" />);

    expect(screen.getByTitle("Chrome Chrome smoke")).toHaveAttribute(
        "src",
        "https://runner.example/browser/?mapache_access=token",
    );
  });

  test("explains when browser access is not ready", () => {
    render(<BrowserCanvas sessionName="Chrome smoke" url="" />);
    expect(screen.getByText("browser_access_unavailable")).toBeInTheDocument();
  });
});

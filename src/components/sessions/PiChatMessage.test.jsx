import {render, screen} from "@testing-library/react";
import {describe, expect, test} from "vitest";
import {PiChatMessage} from "./PiChatMessage.jsx";

const gfm = `# Release notes

**Bold** and *emphasis*, with \`inline()\`.

- bullet
- [x] task

1. ordered

> quoted

[Docs](https://example.com/docs)

\`\`\`js
console.log("hello");
\`\`\`

| Name | Value |
| --- | --- |
| Chat | MVP |
`;

describe("PiChatMessage", () => {
  test("renders required assistant GitHub Flavored Markdown constructs", () => {
    render(<PiChatMessage message={{id: "assistant-1", role: "assistant", markdown: gfm}} />);

    expect(screen.getByRole("heading", {name: "Release notes", level: 1})).toBeInTheDocument();
    expect(screen.getByText("Bold")).toBeInTheDocument();
    expect(screen.getByText("emphasis")).toBeInTheDocument();
    expect(screen.getByText("inline()")).toHaveClass("pi-chat-message__code");
    expect(screen.getAllByRole("list")).toHaveLength(2);
    expect(screen.getByRole("blockquote")).toHaveTextContent("quoted");
    expect(screen.getByRole("link", {name: "Docs"})).toHaveAttribute("href", "https://example.com/docs");
    expect(screen.getByRole("table")).toHaveClass("pi-chat-message__table");
    expect(screen.getByRole("columnheader", {name: "Name"})).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.getByText('console.log("hello");')).toHaveClass("pi-chat-message__code");
    expect(screen.getByRole("article", {name: "Assistant message"})).toBeInTheDocument();
  });

  test("does not execute raw HTML or allow javascript links", () => {
    render(<PiChatMessage message={{
      id: "unsafe",
      role: "assistant",
      markdown: '<script>alert("xss")</script><b>raw</b> [bad](javascript:alert(1))',
    }} />);

    expect(document.querySelector("script")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", {name: "bad"})).toBeNull();
    expect(screen.getByRole("article", {name: "Assistant message"})).toBeEmptyDOMElement();
  });

  test("keeps user Markdown literal and gives code/table content overflow classes", () => {
    const {rerender} = render(<PiChatMessage message={{
      id: "user-1",
      role: "user",
      markdown: "# not a heading\n\n**literal**",
    }} />);
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.getByText((_, element) => element?.tagName === "P" && element.textContent === "# not a heading\n\n**literal**")).toBeInTheDocument();

    rerender(<PiChatMessage message={{id: "assistant-2", role: "assistant", markdown: "```\nlong code\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |"}} />);
    expect(document.querySelector(".pi-chat-message__code-block")).toBeInTheDocument();
    expect(document.querySelector(".pi-chat-message__table")).toBeInTheDocument();
  });
});

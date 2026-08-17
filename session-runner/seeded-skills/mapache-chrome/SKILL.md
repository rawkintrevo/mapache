---
name: mapache-chrome
description: Use the persistent headed Chrome session through the pinned Chrome DevTools MCP server.
---

# Mapache Chrome

This runner already owns one persistent headed Chrome session. Attach to it through the `chrome-devtools` MCP server; do not start another browser and do not read or copy the Chrome profile directory.

Before browser work, run `mapache-chrome-status`. It checks the loopback DevTools endpoint and reports only readiness and version information.

Use the browser tools for navigation, clicks, form entry, screenshots, console inspection, and network debugging. Browser state such as cookies, history, and local storage belongs to the workspace and persists across Pi Chrome and Codex Chrome sessions.

The browser canvas URL is signed and user-facing. The local DevTools URL is for the runner-side MCP connection only. Never print, export, or request browser cookies, profile archives, access tokens, or the values of `SESSION_*` secrets.

When a browser action changes meaningful user state, report the action through the runner activity endpoint if the tool wrapper does not do so automatically.

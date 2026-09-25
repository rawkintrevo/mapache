---
name: mapache-preview-build
description: Build a local web app and serve it on a localhost port for the managed Chrome browser.
---

# Build and view a local web app

The skill name is retained for compatibility. Local app viewing uses managed
Chrome directly, not the former Mapache preview gateway.

1. Inspect the project's package scripts and framework configuration.
2. Run the normal build command. Keep its normal output directory and asset
   base; do not force `/workspace/build`, `--base ./`, or a `/preview/` prefix.
3. Start the project's development or production/static server on an available
   localhost port in a persistent terminal. For a production build, serve its
   actual output directory using the project's supported server.
4. Check the local HTTP endpoint, then open `http://localhost:<port>/` in
   managed Chrome through `chrome-devtools` MCP. Read `mapache-chrome` first.
5. Check rendering, browser console errors, failed network requests, and the
   relevant interactions. Report build results separately from browser QA.

For a Vite development server, when the project supports these options:

```bash
npm run dev -- --host 127.0.0.1 --port 3000
```

Then navigate managed Chrome to `http://localhost:3000/`. Use the actual port
reported by the server if it selects a different one. No preview configuration
file, gateway readiness probe, or gateway URL is needed. Keep the server running
while the user or agent is testing; a runner stop ends the process.

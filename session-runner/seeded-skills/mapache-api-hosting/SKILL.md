---
name: mapache-api-hosting
description: Run an app or API on a localhost port and access it directly in managed Chrome.
---

# Local app and API servers

Use the project's normal server command on an available localhost port. Keep
long-running processes in a persistent terminal, inspect startup errors, and
check readiness directly on that port.

Examples, when supported by the project:

```bash
npm run dev -- --host 127.0.0.1 --port 3000
```

```bash
HOST=127.0.0.1 PORT=3000 npm start
```

Open `http://localhost:3000/` (or the actual selected port) in the existing
managed Chrome browser through `chrome-devtools` MCP. Read `mapache-chrome` for
browser readiness and connection guidance. Test API endpoints directly using
their local URL and inspect browser requests for frontend/API integration.

- Do not configure the former preview gateway or write `.mapache/preview.json`.
- Do not rewrite asset bases or route prefixes just for Mapache.
- Keep servers bound to loopback where supported; do not expose secrets in
  debug responses or logs.
- A local server is not a public deployment. The user's personal browser cannot
  access the runner through its own localhost; use Mapache's managed Chrome.
- Stopping the session stops the server. Report the actual port, server state,
  and verification performed rather than claiming permanent hosting.

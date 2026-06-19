---
name: mapache-api-hosting
description: Host an app or API behind the Mapache preview gateway.
---

Use this skill when a preview needs a running server, API routes, server-rendered app, or function emulator instead of only static files.

## Contract

The runner can proxy /preview/* to a local HTTP server when the workspace contains /workspace/.mapache/preview.json:

```json
{
  "mode": "proxy",
  "upstream": "http://127.0.0.1:3000"
}
```

Only localhost upstreams are accepted. Use 127.0.0.1 or localhost.

## Server Steps

1. Start the app or API server on a local port, usually 127.0.0.1:3000.
2. Write /workspace/.mapache/preview.json with mode "proxy" and the upstream URL.
3. Check readiness with: curl "$MAPACHE_RUNNER_URL/preview/status"
4. Test through the gateway with: curl "$MAPACHE_PREVIEW_URL"

## Examples

Vite dev server:

```bash
npm run dev -- --host 127.0.0.1 --port 3000
```

Express or Node API:

```bash
HOST=127.0.0.1 PORT=3000 npm start
```

Function framework:

```bash
npx functions-framework --target=app --host=127.0.0.1 --port=3000
```

## Return To Static Mode

Remove /workspace/.mapache/preview.json or write:

```json
{
  "mode": "static",
  "staticRoot": "build"
}
```

## Rules

- Keep servers bound to localhost.
- Do not expose secret-bearing debug endpoints in the preview.
- Use $MAPACHE_PREVIEW_URL for QA, because it exercises the same route the user sees in the Preview canvas.

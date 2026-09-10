# Gate A environment and reproduction

## Prototype pins

- Pi installed on the local fixture host: `0.80.6` (observed with `pi --version`).
- Pi image pin for `pi-chrome`: `@earendil-works/pi-coding-agent@0.84.1`.
- Managed Goals package: `pi-goal-x@0.31.2`.
- Pi MCP adapter pin for `pi-chrome`: `pi-mcp-adapter@2.32.1`.
- Node: `v24.6.0` on the fixture host; the image uses `node:24-bookworm-slim`.
- Adapter revision: `gate-a-0.1.0`.
- Current pre-Gate-A `pi-chrome` image digest from the active Goals docs:
  `sha256:4c12dcdfb3ce65bc61b12df175bc8b939291c0f955a6ca6c0ec6b96e1b9e39f3`.
  The rebuilt digest is recorded after the requested Cloud Build deployment.

## Reproduction

The deterministic boundary suite is part of the runner test command:

```bash
npm --prefix session-runner run lint
npm --prefix session-runner test
```

The opt-in live fixture uses a temporary home/workspace, an empty isolated
`auth.json`, a disposable PTY, and a socket outside the workspace. It removes
the fixture root and stops the Pi process in both success and failure paths:

```bash
node session-runner/test-fixtures/web-first/run-gate-a.js
```

The live command does not send a model request. It is intentionally separate
from deterministic tests and records dispatch/input evidence plus unsupported
operation results without copying credentials into artifacts.

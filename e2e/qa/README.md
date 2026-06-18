# QA Test Cases

This directory stores opt-in browser QA definitions for Chrome DevTools-assisted testing. Run these only when the user explicitly asks for QA, smoke, browser, or end-to-end testing.

## Structure

- `scripts/`: Single reusable actions. Scripts should do one thing, such as sign in, open a drawer, create a workspace, or capture console/network evidence.
- `cases/`: Ordered test cases. Cases compose scripts and may include other cases through `useCase`.

## Case Format

Cases are JSON manifests with stable IDs:

```json
{
  "id": "auth.login",
  "title": "QA login reaches signed-in app shell",
  "baseUrl": "http://127.0.0.1:5173",
  "artifactsDir": "artifacts/qa",
  "steps": [
    {"useScript": "scripts/login-qa.json"},
    {"assert": "app-shell-authenticated"}
  ]
}
```

Supported step keys:

- `useScript`: Path to a script manifest under `e2e/qa/`.
- `useCase`: Path to another case manifest under `e2e/qa/`.
- `assert`: Named expectation for the agent to verify using page snapshot, console, network, or deterministic script output.
- `capture`: Artifact request such as `screenshot`, `console`, or `network`.

Keep manifests deterministic. Do not put secrets in case or script files.

# QA Result Format

Return this shape in the final answer:

```json
{
  "scenarioId": "auth.login",
  "status": "passed|failed|blocked",
  "observations": [
    "Short factual observation"
  ],
  "evidence": [
    "artifacts/qa/auth.login/app-shell.png",
    "Network: POST /api/qa/custom-token -> 200"
  ],
  "failureReason": ""
}
```

Use `blocked` when setup is missing, such as no Chrome DevTools server, no QA secret, no reachable dev server, or unsupported manifest steps.

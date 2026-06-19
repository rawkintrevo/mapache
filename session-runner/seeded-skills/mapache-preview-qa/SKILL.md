---
name: mapache-preview-qa
description: QA a Mapache preview with the runner-owned browser QA command, status checks, console logs, screenshots, and structured reports.
---

Use this skill after building a site or starting a preview server in a Mapache preview-capable session.

## Contract

- Preview URL: $MAPACHE_PREVIEW_URL
- Runner URL: $MAPACHE_RUNNER_URL
- QA artifact directory: $MAPACHE_QA_DIR
- Browser QA command: $MAPACHE_BROWSER_QA_COMMAND
- Browser console/error logs: $MAPACHE_RUNNER_URL/preview/logs
- Preview status: $MAPACHE_RUNNER_URL/preview/status

## QA Steps

1. Create the QA directory: mkdir -p "$MAPACHE_QA_DIR/latest"
2. Confirm preview readiness: curl "$MAPACHE_RUNNER_URL/preview/status"
3. Write a browser QA spec when interactions are needed.
4. Run the supported browser command so the runner-owned QA contract launches Chromium, captures screenshots, and collects console/page/request failures.
4. Check runner-side browser logs: curl "$MAPACHE_RUNNER_URL/preview/logs"
5. Write findings to $MAPACHE_QA_DIR/latest/report.md and $MAPACHE_QA_DIR/latest/report.json.

## Minimal Browser QA Run

```bash
$MAPACHE_BROWSER_QA_COMMAND
```

## Example Interaction Spec

```json
{
  "steps": [
    {"action": "waitFor", "selector": "body"},
    {"action": "click", "selector": "button[type='submit']"},
    {"action": "fill", "selector": "input[name='email']", "value": "qa@example.com"},
    {"action": "press", "selector": "input[name='email']", "key": "Enter"},
    {"action": "screenshot", "name": "after-submit"}
  ]
}
```

Run it with:

```bash
$MAPACHE_BROWSER_QA_COMMAND --spec /workspace/.mapache/qa/spec.json
```

## What To Look For

- Blank screens or missing primary content.
- Console errors, unhandled promise rejections, failed network requests, and broken assets.
- Layout clipping or overlap at desktop and mobile viewport sizes.
- Buttons and navigation that do not respond.
- Forms that cannot be completed or fail without useful feedback.

## Rules

- Save screenshots and reports under $MAPACHE_QA_DIR/latest.
- Prefer testing through $MAPACHE_PREVIEW_URL, not direct localhost upstream ports.
- Use $MAPACHE_BROWSER_QA_COMMAND instead of embedding a one-off Playwright launch script.
- Treat console errors as actionable unless they are clearly third-party noise and documented in the report.

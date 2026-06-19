---
name: mapache-preview-qa
description: QA a Mapache preview with status checks, console logs, screenshots, and Playwright.
---

Use this skill after building a site or starting a preview server in a Mapache preview-capable session.

## Contract

- Preview URL: $MAPACHE_PREVIEW_URL
- Runner URL: $MAPACHE_RUNNER_URL
- QA artifact directory: $MAPACHE_QA_DIR
- Browser console/error logs: $MAPACHE_RUNNER_URL/preview/logs
- Preview status: $MAPACHE_RUNNER_URL/preview/status

## QA Steps

1. Create the QA directory: mkdir -p "$MAPACHE_QA_DIR/latest"
2. Confirm preview readiness: curl "$MAPACHE_RUNNER_URL/preview/status"
3. Load the page with Playwright, capture screenshots, and collect console/page errors.
4. Check runner-side browser logs: curl "$MAPACHE_RUNNER_URL/preview/logs"
5. Write findings to $MAPACHE_QA_DIR/latest/report.md and $MAPACHE_QA_DIR/latest/report.json.

## Minimal Playwright Screenshot

```bash
node - <<'EOF'
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

(async () => {
  const qaDir = process.env.MAPACHE_QA_DIR || '/workspace/.mapache/qa';
  const outDir = path.join(qaDir, 'latest');
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox']
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const events = [];
  page.on('console', (msg) => events.push({ type: 'console', level: msg.type(), text: msg.text() }));
  page.on('pageerror', (error) => events.push({ type: 'pageerror', text: error.message }));
  await page.goto(process.env.MAPACHE_PREVIEW_URL, { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(outDir, 'home-desktop.png'), fullPage: true });
  fs.writeFileSync(path.join(outDir, 'events.json'), JSON.stringify(events, null, 2));
  await browser.close();
})();
EOF
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
- Treat console errors as actionable unless they are clearly third-party noise and documented in the report.

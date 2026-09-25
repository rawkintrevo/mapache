---
name: mapache-preview-qa
description: Test a local app in managed Chrome using screenshots, console inspection, network checks, and user interactions.
---

# Local browser QA

The skill name is retained for compatibility. Use the existing managed Chrome
browser, not the former preview gateway or a separately launched browser.

1. Read `mapache-chrome`, run `mapache-chrome-status`, and discover the
   `chrome-devtools` MCP tools.
2. Start the app with its normal server command on an available localhost port
   in a persistent terminal. Check its startup output and local HTTP readiness.
3. Navigate managed Chrome to `http://localhost:<port>/`.
4. Exercise the requested user flows with browser tools. Inspect console
   errors, failed network requests, missing assets, and unexpected UI states.
5. Capture useful screenshots and record the tested URL, steps, expected/actual
   results, and remaining limitations under a workspace artifact directory
   such as `artifacts/qa/`. In an automation, use its assigned output directory.
6. Fix relevant failures and repeat the affected checks before claiming success.

Check for blank screens, clipped layouts, broken navigation, unresponsive
buttons, and forms that fail without useful feedback. Test relevant viewport
sizes when supported. Treat console errors as actionable unless they are
clearly unrelated noise documented in the report.

Do not use preview-gateway status/log endpoints or gateway URLs. A successful
build or HTTP probe is not a browser test. Do not submit real purchases,
messages, or destructive changes merely to test a flow without authorization.

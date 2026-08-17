#!/usr/bin/env node

"use strict";

const cdpUrl = String(process.env.MAPACHE_BROWSER_CDP_URL ||
  `http://127.0.0.1:${process.env.CHROME_CDP_PORT || 9222}`).replace(/\/+$/, "");

async function main() {
  try {
    const response = await fetch(`${cdpUrl}/json/version`);
    if (!response.ok) throw new Error(`status_${response.status}`);
    const body = await response.json();
    const browser = String(body.Browser || body.browser || "unknown").slice(0, 120);
    console.log(JSON.stringify({ok: true, browser, cdp: cdpUrl}));
  } catch (error) {
    console.error(JSON.stringify({ok: false, error: "chrome_unavailable"}));
    process.exitCode = 1;
  }
}

main();

"use strict";

const {appendAccessToken} = require("./previewHelpers");

function createPreviewLogService(config) {
  const logs = [];
  const streams = new Set();

  function appendLog(body) {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      level: normalizePreviewLogLevel(body.level),
      args: Array.isArray(body.args) ? body.args.map((item) => String(item).slice(0, 2000)) : [],
      href: String(body.href || "").slice(0, 2000),
      at: body.at || new Date().toISOString(),
      receivedAt: new Date().toISOString(),
    };
    logs.push(entry);
    if (logs.length > config.previewLogLimit) {
      logs.splice(0, logs.length - config.previewLogLimit);
    }
    for (const stream of streams) {
      stream.write(`data: ${JSON.stringify(entry)}\n\n`);
    }
    return entry;
  }

  function streamLogs(req, res) {
    res.writeHead(200, {
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Content-Type": "text/event-stream",
    });
    for (const entry of logs) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }
    streams.add(res);
    req.on("close", () => {
      streams.delete(res);
    });
  }

  function injectHtmlLogger(html, accessToken) {
    const script = loggerScript(accessToken);
    if (html.includes("</head>")) return html.replace("</head>", `${script}</head>`);
    if (html.includes("</body>")) return html.replace("</body>", `${script}</body>`);
    return `${script}${html}`;
  }

  function loggerScript(accessToken) {
    const endpoint = appendAccessToken(`${config.previewBasePath}/logs`, accessToken);
    return `<script>
(() => {
  if (window.__mapachePreviewLoggerInstalled) return;
  window.__mapachePreviewLoggerInstalled = true;
  const endpoint = ${JSON.stringify(endpoint)};
  const serialize = (item) => {
    if (typeof item === "string") return item;
    if (item instanceof Error) return item.stack || item.message || String(item);
    try {
      const json = JSON.stringify(item);
      return typeof json === "string" ? json : String(item);
    } catch (error) {
      return String(item);
    }
  };
  const send = (level, args) => {
    const payload = {
      level,
      args: Array.from(args || []).map(serialize),
      href: location.href,
      at: new Date().toISOString()
    };
    fetch(endpoint, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload),
      keepalive: true
    }).catch(() => {});
  };
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level];
    console[level] = (...args) => {
      send(level, args);
      original.apply(console, args);
    };
  }
  window.addEventListener("error", (event) => {
    send("error", [event.message, event.filename + ":" + event.lineno + ":" + event.colno]);
  });
  window.addEventListener("unhandledrejection", (event) => {
    send("error", ["Unhandled rejection", event.reason]);
  });
})();
</script>`;
  }

  return {appendLog, injectHtmlLogger, loggerScript, logs, streamLogs};
}

function normalizePreviewLogLevel(level) {
  const value = String(level || "log").toLowerCase();
  return ["log", "info", "warn", "error"].includes(value) ? value : "log";
}

module.exports = {createPreviewLogService};

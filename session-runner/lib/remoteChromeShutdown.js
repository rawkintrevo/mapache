"use strict";

const {once} = require("node:events");

// Browser.close flushes recent login cookies before the guest's X server exits.
async function closeRemoteChrome(child, config) {
  if (child.exitCode !== null || child.signalCode) return;
  const controller = new AbortController();
  const {signal} = controller;
  const timeout = setTimeout(() => controller.abort(), 4000);
  let socket;
  try {
    const endpoint = new URL(`http://127.0.0.1:${config.chromeCdpPort}/json/version`);
    const response = await fetch(endpoint, {signal, redirect: "error"});
    if (!response.ok) throw new Error("chrome_status_unavailable");
    const url = new URL((await response.json()).webSocketDebuggerUrl);
    if (url.protocol !== "ws:" || url.host !== endpoint.host) throw new Error("unexpected_chrome_endpoint");
    socket = new WebSocket(url);
    await once(socket, "open", {signal});
    socket.send(JSON.stringify({id: 1, method: "Browser.close"}));
    await once(child, "exit", {signal});
  } catch {
    // A crashed or unresponsive browser falls through to ordinary SIGTERM.
  } finally {
    clearTimeout(timeout);
    controller.abort();
    socket?.close();
  }
}

module.exports = {closeRemoteChrome};

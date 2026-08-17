"use strict";

const net = require("net");

function createVncBridge(options = {}) {
  const netImpl = options.net || net;
  const host = options.host || "127.0.0.1";
  const port = Number(options.port || 5900);

  return {
    attach,
  };

  function attach(webSocket) {
    const tcp = netImpl.connect({host, port});
    let closed = false;

    tcp.on("data", (chunk) => {
      if (webSocket.readyState === undefined || webSocket.readyState === webSocket.OPEN || webSocket.readyState === 1) {
        webSocket.send(chunk, {binary: true});
      }
    });
    tcp.on("error", () => closeBoth());
    tcp.on("close", () => closeWebSocket());
    webSocket.on("message", (data) => {
      if (!closed && !tcp.destroyed) tcp.write(Buffer.from(data));
    });
    webSocket.on("error", () => closeBoth());
    webSocket.on("close", () => closeTcp());

    return {tcp, close: closeBoth};

    function closeTcp() {
      if (closed) return;
      closed = true;
      if (typeof tcp.destroy === "function") tcp.destroy();
    }

    function closeWebSocket() {
      if (closed) return;
      closed = true;
      if (typeof webSocket.close === "function") webSocket.close();
    }

    function closeBoth() {
      closeTcp();
      if (typeof webSocket.close === "function") webSocket.close();
    }
  }
}

module.exports = {
  createVncBridge,
};

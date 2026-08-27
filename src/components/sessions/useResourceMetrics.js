import {useEffect, useState} from "react";

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 5000];
const EMPTY_STATE = {sample: null, connectionState: "idle", error: null};

export function useResourceMetrics({enabled = false, sessionId = "", socketUrl = ""} = {}) {
  const [state, setState] = useState(EMPTY_STATE);

  useEffect(() => {
    let socket = null;
    let reconnectTimer = null;
    let deliberate = false;
    let reconnectAttempt = 0;
    let generation = 0;
    let invalidMessageCount = 0;

    setState(EMPTY_STATE);
    if (!enabled || !sessionId || !isSocketUrl(socketUrl)) return () => {};
    const currentGeneration = ++generation;

    setState({...EMPTY_STATE, connectionState: "connecting"});
    connect();

    return () => {
      deliberate = true;
      generation += 1;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
      closeSocket();
    };

    function connect() {
      if (deliberate || generation !== currentGeneration) return;
      const WebSocketConstructor = globalThis.WebSocket;
      if (typeof WebSocketConstructor !== "function") {
        setState((current) => ({...current, connectionState: "unavailable", error: "socket_unavailable"}));
        return;
      }

      setState((current) => ({
        ...current,
        connectionState: reconnectAttempt ? "reconnecting" : "connecting",
      }));
      try {
        const nextSocket = new WebSocketConstructor(socketUrl);
        socket = nextSocket;
        attachSocketListeners(nextSocket);
      } catch (error) {
        scheduleReconnect();
      }
    }

    function attachSocketListeners(connectedSocket) {
      connectedSocket.addEventListener("open", () => {
        if (!isCurrent(connectedSocket)) return;
        reconnectAttempt = 0;
        setState((current) => ({...current, connectionState: "connected", error: null}));
      });
      connectedSocket.addEventListener("message", (event) => {
        if (!isCurrent(connectedSocket)) return;
        handleMessage(event.data);
      });
      connectedSocket.addEventListener("close", () => {
        if (!isCurrent(connectedSocket)) return;
        socket = null;
        if (!deliberate) scheduleReconnect();
      });
      connectedSocket.addEventListener("error", () => {});
    }

    function handleMessage(rawData) {
      let message;
      try {
        message = JSON.parse(typeof rawData === "string" ? rawData : String(rawData));
      } catch (error) {
        markInvalidMessage();
        return;
      }
      if (message?.type === "metrics_unavailable" && message.code === "resource_metrics_unavailable") {
        setState((current) => ({...current, connectionState: "unavailable", error: message.code}));
        return;
      }
      if (!isValidSample(message)) {
        markInvalidMessage();
        return;
      }
      invalidMessageCount = 0;
      setState((current) => ({...current, sample: message, connectionState: "connected", error: null}));
    }

    function markInvalidMessage() {
      invalidMessageCount += 1;
      if (invalidMessageCount >= 3) {
        setState((current) => ({...current, error: "protocol_error"}));
      }
    }

    function scheduleReconnect() {
      if (deliberate || generation !== currentGeneration || reconnectTimer !== null) return;
      const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
      reconnectAttempt += 1;
      setState((current) => ({...current, connectionState: "reconnecting"}));
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    function closeSocket() {
      if (!socket) return;
      const oldSocket = socket;
      socket = null;
      try {
        oldSocket.close();
      } catch (error) {
        // Closing an already-closed browser socket is harmless during cleanup.
      }
    }

    function isCurrent(connectedSocket) {
      return generation === currentGeneration && socket === connectedSocket;
    }
  }, [enabled, sessionId, socketUrl]);

  return state;
}

function isSocketUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "ws:" || url.protocol === "wss:";
  } catch (error) {
    return false;
  }
}

function isValidSample(message) {
  return Boolean(message && message.type === "metrics" && Number.isFinite(message.sampledAt) &&
    Number.isFinite(message.cpu?.percent) && message.cpu.percent >= 0 && message.cpu.percent <= 100 &&
    Number.isFinite(message.cpu?.limitCores) && message.cpu.limitCores > 0 &&
    Number.isFinite(message.memory?.percent) && message.memory.percent >= 0 && message.memory.percent <= 100 &&
    Number.isFinite(message.memory?.usedBytes) && message.memory.usedBytes >= 0 &&
    Number.isFinite(message.memory?.limitBytes) && message.memory.limitBytes > 0);
}

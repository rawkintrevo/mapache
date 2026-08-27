import {useCallback, useEffect, useRef, useState} from "react";

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 5000];
const SAFE_ERROR_PATTERN = /^[a-z0-9_]{1,64}$/;

const EMPTY_STATE = {
  messages: [],
  connectionState: "idle",
  status: "ready",
  error: null,
  acknowledgements: {},
};

export function usePiChat({enabled = false, sessionId = "", socketUrl = ""} = {}) {
  const [state, setState] = useState(EMPTY_STATE);
  const socketRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const generationRef = useRef(0);
  const deliberateRef = useRef(false);
  const reconnectAttemptRef = useRef(0);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    deliberateRef.current = false;
    reconnectAttemptRef.current = 0;
    clearReconnectTimer();
    closeSocket();
    let invalidMessageCount = 0;

    if (!enabled || !sessionId || !isSocketUrl(socketUrl)) {
      setState(EMPTY_STATE);
      return () => {};
    }

    setState({...EMPTY_STATE, connectionState: "connecting"});
    connect();

    return () => {
      deliberateRef.current = true;
      generationRef.current += 1;
      clearReconnectTimer();
      closeSocket();
    };

    function connect() {
      if (deliberateRef.current || generationRef.current !== generation) return;
      const WebSocketConstructor = globalThis.WebSocket;
      if (typeof WebSocketConstructor !== "function") {
        setState((current) => ({...current, connectionState: "failed", error: "socket_unavailable"}));
        return;
      }

      setState((current) => ({
        ...current,
        connectionState: reconnectAttemptRef.current ? "reconnecting" : "connecting",
      }));
      let socket;
      try {
        socket = new WebSocketConstructor(socketUrl);
      } catch (error) {
        scheduleReconnect();
        return;
      }
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        if (!isCurrent(socket)) return;
        reconnectAttemptRef.current = 0;
        setState((current) => ({...current, connectionState: "connected", error: null}));
      });
      socket.addEventListener("message", (event) => {
        if (!isCurrent(socket)) return;
        handleServerMessage(event.data);
      });
      socket.addEventListener("close", () => {
        if (!isCurrent(socket)) return;
        socketRef.current = null;
        if (!deliberateRef.current) scheduleReconnect();
      });
      socket.addEventListener("error", () => {
        // The close event owns reconnect behavior. Do not expose browser error details.
      });
    }

    function handleServerMessage(rawData) {
      let message;
      try {
        message = JSON.parse(typeof rawData === "string" ? rawData : String(rawData));
      } catch (error) {
        markInvalidMessage();
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        markInvalidMessage();
        return;
      }

      switch (message.type) {
        case "snapshot":
          setState((current) => ({...current, messages: normalizeMessages(message.messages), error: null}));
          return;
        case "reset":
          setState((current) => ({...current, messages: normalizeMessages(message.messages), error: null}));
          return;
        case "message": {
          const normalized = normalizeMessage(message.message);
          if (!normalized) {
            markInvalidMessage();
            return;
          }
          setState((current) => current.messages.some((item) => item.id === normalized.id) ? current : {
            ...current,
            messages: [...current.messages, normalized],
            error: null,
          });
          return;
        }
        case "prompt_ack":
          if (typeof message.clientId !== "string" || !message.clientId.trim()) {
            markInvalidMessage();
            return;
          }
          setState((current) => ({
            ...current,
            acknowledgements: {...current.acknowledgements, [message.clientId]: true},
            error: null,
          }));
          return;
        case "status":
          if (!["waiting_for_transcript", "working", "ready"].includes(message.status)) {
            markInvalidMessage();
            return;
          }
          setState((current) => ({...current, status: message.status, error: null}));
          return;
        case "error": {
          const code = safeErrorCode(message.code);
          if (!code) {
            markInvalidMessage();
            return;
          }
          const terminalFailure = /auth|access|expired|unsupported|unauthorized/.test(code);
          setState((current) => ({
            ...current,
            connectionState: terminalFailure ? "failed" : current.connectionState,
            error: code,
          }));
          if (terminalFailure) {
            deliberateRef.current = true;
            clearReconnectTimer();
            closeSocket();
          }
          return;
        }
        default:
          markInvalidMessage();
      }
    }

    function markInvalidMessage() {
      invalidMessageCount += 1;
      if (invalidMessageCount >= 3) {
        setState((current) => ({...current, error: "protocol_error"}));
      }
    }

    function scheduleReconnect() {
      if (deliberateRef.current || generationRef.current !== generation || reconnectTimerRef.current !== null) return;
      const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttemptRef.current, RECONNECT_DELAYS_MS.length - 1)];
      reconnectAttemptRef.current += 1;
      setState((current) => ({...current, connectionState: "reconnecting"}));
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, delay);
    }

    function isCurrent(socket) {
      return generationRef.current === generation && socketRef.current === socket;
    }

    function clearReconnectTimer() {
      if (reconnectTimerRef.current === null) return;
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    function closeSocket() {
      const socket = socketRef.current;
      socketRef.current = null;
      if (!socket) return;
      try {
        socket.close();
      } catch (error) {
        // Cleanup must remain safe if a browser socket is already closed.
      }
    }
  }, [enabled, sessionId, socketUrl]);

  const sendPrompt = useCallback(({clientId, text} = {}) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== 1 || typeof clientId !== "string" || typeof text !== "string") return false;
    try {
      socket.send(JSON.stringify({type: "prompt", clientId, text}));
      return true;
    } catch (error) {
      setState((current) => ({...current, error: "prompt_send_failed"}));
      return false;
    }
  }, []);

  return {...state, sendPrompt};
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const seen = new Set();
  return messages.map(normalizeMessage).filter((message) => {
    if (!message || seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

function normalizeMessage(message) {
  if (!message || typeof message !== "object" || !["user", "assistant"].includes(message.role) ||
    typeof message.id !== "string" || !message.id || typeof message.markdown !== "string") return null;
  return {
    id: message.id,
    role: message.role,
    markdown: message.markdown,
    createdAt: message.createdAt === null || message.createdAt === undefined ? null : String(message.createdAt),
  };
}

function safeErrorCode(value) {
  const code = typeof value === "string" ? value : "";
  return SAFE_ERROR_PATTERN.test(code) ? code : "";
}

function isSocketUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "ws:" || url.protocol === "wss:";
  } catch (error) {
    return false;
  }
}

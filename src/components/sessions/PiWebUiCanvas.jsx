import {ExternalLink} from "lucide-react";
import {useCallback, useEffect, useRef, useState} from "react";
import {Button} from "../common/Button.jsx";

const BRIDGE_VERSION = 1;
const ACCESS_MESSAGE = "mapache.agent.access";

export function PiWebUiCanvas({accessError = "", sessionName, url, onAccessRefreshNeeded}) {
  const frameRef = useRef(null);
  const initialUrlRef = useRef(url);
  const origin = getAgentOrigin(url);
  const [status, setStatus] = useState(origin ? "loading" : "error");
  const [error, setError] = useState(origin ? "" : "agent_access_unavailable");
  const visibleError = accessError || error;

  const sendAccess = useCallback(() => {
    const frame = frameRef.current;
    if (!frame?.contentWindow || !origin || !url) return false;
    try {
      frame.contentWindow.postMessage({
        type: ACCESS_MESSAGE,
        version: BRIDGE_VERSION,
        agentUrl: url,
      }, origin);
      return true;
    } catch {
      return false;
    }
  }, [origin, url]);

  useEffect(() => {
    if (!origin) {
      setStatus("error");
      setError("agent_access_unavailable");
      return undefined;
    }
    setStatus((current) => current === "ready" ? "renewing" : current);
    sendAccess();
    const onMessage = (event) => {
      const frame = frameRef.current;
      if (!frame?.contentWindow || event.source !== frame.contentWindow || event.origin !== origin) return;
      const message = parseBridgeMessage(event.data);
      if (!message) return;
      if (message.type === "mapache.agent.ready") {
        setError("");
        setStatus("ready");
        sendAccess();
        return;
      }
      if (message.type === "mapache.agent.renewal-request") {
        setStatus("renewing");
        if (typeof onAccessRefreshNeeded === "function") onAccessRefreshNeeded();
        else {
          setError("agent_access_renewal_unavailable");
          setStatus("error");
        }
        return;
      }
      if (message.status === "access-renewed") {
        setError("");
        setStatus("ready");
      } else {
        setError(message.error || "agent_access_refresh_failed");
        setStatus("error");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onAccessRefreshNeeded, origin, sendAccess]);

  useEffect(() => {
    if (status === "ready" || status === "renewing") sendAccess();
  }, [sendAccess, status, url]);

  if (!origin) {
    return (
      <div className="terminal-placeholder">
        <p>
          Agent access is not ready.
          <br />
          <code>{error || "agent_access_unavailable"}</code>
        </p>
      </div>
    );
  }

  return (
    <div className="pi-web-ui-canvas">
      <div className="pi-web-ui-canvas__toolbar">
        <span>Agent</span>
        <Button
          aria-label="Open Agent in new tab"
          variant="secondary"
          onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
        >
          <ExternalLink aria-hidden="true" />
          Open Agent
        </Button>
      </div>
      <div className="pi-web-ui-canvas__frame-wrap">
        <iframe
          ref={frameRef}
          allow="clipboard-read; clipboard-write; fullscreen"
          className="pi-web-ui-canvas__frame"
          src={initialUrlRef.current}
          title={`Agent ${sessionName}`}
          onLoad={sendAccess}
        />
        {status !== "ready" ? (
          <div aria-live="polite" className={`pi-web-ui-canvas__status pi-web-ui-canvas__status--${status}`} role="status">
            <strong>{accessError ? "Agent access error" : status === "renewing" ? "Refreshing Agent access" : status === "error" ? "Agent access error" : "Loading Agent"}</strong>
            {status === "error" || accessError ? <code>{visibleError || "agent_access_refresh_failed"}</code> : <span>The embedded workspace is connecting.</span>}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function getAgentOrigin(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : "";
  } catch {
    return "";
  }
}

export function parseBridgeMessage(value) {
  if (!value || typeof value !== "object" || value.version !== BRIDGE_VERSION || typeof value.type !== "string") return null;
  if (value.type === "mapache.agent.ready") return {type: value.type, version: value.version};
  if (value.type === "mapache.agent.renewal-request" && ["expired", "bootstrap", "connection-error"].includes(value.reason)) {
    return {type: value.type, version: value.version, reason: value.reason};
  }
  if (value.type === "mapache.agent.status" && ["access-renewed", "access-error"].includes(value.status)) {
    return {
      type: value.type,
      version: value.version,
      status: value.status,
      ...(value.error === "access_refresh_failed" ? {error: value.error} : {}),
    };
  }
  return null;
}

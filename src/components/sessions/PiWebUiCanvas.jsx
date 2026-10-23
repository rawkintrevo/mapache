import {useCallback, useEffect, useRef, useState} from "react";

const BRIDGE_VERSION = 1;
const ACCESS_MESSAGE = "mapache.agent.access";
export const AGENT_BOOTSTRAP_TIMEOUT_MS = 20_000;
const MAX_BOOTSTRAP_RETRIES = 2;

export function PiWebUiCanvas({accessError = "", sessionName, url, onAccessRefreshNeeded, onOpenChrome}) {
  const frameRef = useRef(null);
  const latestUrlRef = useRef(url);
  const bootstrapTimerRef = useRef(null);
  const [bootstrap, setBootstrap] = useState({url, key: 0, retries: 0});
  const origin = getAgentOrigin(url);
  const readyRef = useRef(false);
  const lastSentUrlRef = useRef(null);
  const callbacksRef = useRef({onAccessRefreshNeeded, onOpenChrome});
  const [status, setStatus] = useState(origin ? "loading" : "error");
  const [error, setError] = useState(origin ? "" : "agent_access_unavailable");
  const visibleError = accessError || error;

  callbacksRef.current = {onAccessRefreshNeeded, onOpenChrome};
  latestUrlRef.current = url;

  const retryBootstrap = useCallback((manual = false) => {
    readyRef.current = false;
    lastSentUrlRef.current = null;
    setError("");
    setStatus("loading");
    setBootstrap((current) => ({
      url: latestUrlRef.current,
      key: current.key + 1,
      retries: manual ? 0 : current.retries + 1,
    }));
    callbacksRef.current.onAccessRefreshNeeded?.();
  }, []);

  useEffect(() => {
    if (!origin || readyRef.current) return undefined;
    bootstrapTimerRef.current = window.setTimeout(() => {
      if (readyRef.current) return;
      if (bootstrap.retries < MAX_BOOTSTRAP_RETRIES) retryBootstrap();
      else {
        setError("agent_load_timeout");
        setStatus("error");
      }
    }, AGENT_BOOTSTRAP_TIMEOUT_MS);
    return () => window.clearTimeout(bootstrapTimerRef.current);
  }, [bootstrap, origin, retryBootstrap]);

  const sendAccess = useCallback((accessUrl = url) => {
    const frame = frameRef.current;
    if (!frame?.contentWindow || !origin || !accessUrl) return false;
    try {
      frame.contentWindow.postMessage({
        type: ACCESS_MESSAGE,
        version: BRIDGE_VERSION,
        agentUrl: accessUrl,
      }, origin);
      lastSentUrlRef.current = accessUrl;
      return true;
    } catch {
      return false;
    }
  }, [origin, url]);

  useEffect(() => {
    if (!origin) {
      readyRef.current = false;
      lastSentUrlRef.current = null;
      setStatus("error");
      setError("agent_access_unavailable");
      return undefined;
    }
    const onMessage = (event) => {
      const frame = frameRef.current;
      if (!frame?.contentWindow || event.source !== frame.contentWindow || event.origin !== origin) return;
      const message = parseBridgeMessage(event.data);
      if (!message) return;
      if (message.type === "mapache.agent.ready") {
        window.clearTimeout(bootstrapTimerRef.current);
        readyRef.current = true;
        setError("");
        setStatus("ready");
        if (lastSentUrlRef.current !== url) sendAccess(url);
        return;
      }
      if (message.type === "mapache.agent.renewal-request") {
        setStatus("renewing");
        if (typeof callbacksRef.current.onAccessRefreshNeeded === "function") callbacksRef.current.onAccessRefreshNeeded();
        else {
          setError("agent_access_renewal_unavailable");
          setStatus("error");
        }
        return;
      }
      if (message.type === "mapache.agent.navigate") {
        callbacksRef.current.onOpenChrome?.();
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
  }, [origin, sendAccess, url]);

  useEffect(() => {
    if (!readyRef.current || lastSentUrlRef.current === url) return;
    setStatus("renewing");
    sendAccess(url);
  }, [sendAccess, url]);

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
      <div className="pi-web-ui-canvas__frame-wrap">
        <iframe
          key={bootstrap.key}
          ref={frameRef}
          allow="clipboard-read; clipboard-write; fullscreen"
          className="pi-web-ui-canvas__frame"
          src={bootstrap.url}
          title={`Agent ${sessionName}`}
        />
        {status !== "ready" ? (
          <div aria-live="polite" className={`pi-web-ui-canvas__status pi-web-ui-canvas__status--${status}`} role="status">
            <strong>{error === "agent_load_timeout" ? "Agent did not load" : accessError ? "Agent access error" : status === "renewing" ? "Refreshing Agent access" : status === "error" ? "Agent access error" : "Loading Agent"}</strong>
            {error === "agent_load_timeout" ? (
              <>
                <span>The workspace could not connect. Retry to load it again.</span>
                <button type="button" onClick={() => retryBootstrap(true)}>Retry Agent</button>
              </>
            ) : status === "error" || accessError ? <code>{visibleError || "agent_access_refresh_failed"}</code> : <span>{bootstrap.retries ? "Retrying the workspace connection…" : "The embedded workspace is connecting."}</span>}
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
  if (value.type === "mapache.agent.navigate" && value.surface === "chrome") {
    return {type: value.type, version: value.version, surface: value.surface};
  }
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

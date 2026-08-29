import {useCallback, useEffect, useRef, useState} from "react";

const RENEWAL_LEAD_MS = 5 * 60 * 1000;
const RENEWAL_RETRY_MS = 30 * 1000;
const FAILURE_REFRESH_COOLDOWN_MS = 30 * 1000;

const EMPTY_STATE = {
  accessUrls: null,
  error: "",
  loading: false,
};

export function useSessionAccessUrls({
  enabled = false,
  workspaceId = "",
  sessionId = "",
  serviceUrl = "",
  loadAccessUrls,
} = {}) {
  const [state, setState] = useState(EMPTY_STATE);
  const requestRef = useRef(null);
  const generationRef = useRef(0);
  const failureRefreshAtRef = useRef(null);

  const refresh = useCallback(async ({clear = false} = {}) => {
    if (!enabled || !workspaceId || !sessionId || !serviceUrl || typeof loadAccessUrls !== "function") {
      return false;
    }
    if (requestRef.current) return requestRef.current;

    const generation = generationRef.current;
    setState((current) => ({
      accessUrls: clear ? null : current.accessUrls,
      error: clear ? "" : current.error,
      loading: true,
    }));

    const request = Promise.resolve()
        .then(() => loadAccessUrls(workspaceId, sessionId))
        .then((accessUrls) => {
          if (generationRef.current !== generation) return false;
          setState({accessUrls, error: "", loading: false});
          return true;
        })
        .catch((error) => {
          if (generationRef.current !== generation) return false;
          setState((current) => ({
            accessUrls: current.accessUrls,
            error: current.accessUrls ? "" : error.message || "session_access_unavailable",
            loading: false,
          }));
          return false;
        })
        .finally(() => {
          if (requestRef.current === request) requestRef.current = null;
        });
    requestRef.current = request;
    return request;
  }, [enabled, loadAccessUrls, serviceUrl, sessionId, workspaceId]);

  useEffect(() => {
    generationRef.current += 1;
    requestRef.current = null;
    failureRefreshAtRef.current = null;
    setState(EMPTY_STATE);
    void refresh({clear: true});

    return () => {
      generationRef.current += 1;
      requestRef.current = null;
    };
  }, [refresh]);

  useEffect(() => {
    const expiresAtMs = Date.parse(state.accessUrls?.expiresAt || "");
    if (!Number.isFinite(expiresAtMs)) return undefined;

    let cancelled = false;
    let timer = null;
    const schedule = (delay) => {
      timer = window.setTimeout(async () => {
        const renewed = await refresh();
        if (!cancelled && !renewed) schedule(RENEWAL_RETRY_MS);
      }, delay);
    };
    schedule(Math.max(0, expiresAtMs - Date.now() - RENEWAL_LEAD_MS));

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [refresh, state.accessUrls?.expiresAt]);

  const refreshAfterConnectionFailure = useCallback(() => {
    const now = Date.now();
    if (failureRefreshAtRef.current !== null &&
      now - failureRefreshAtRef.current < FAILURE_REFRESH_COOLDOWN_MS) return false;
    failureRefreshAtRef.current = now;
    void refresh();
    return true;
  }, [refresh]);

  return {...state, refresh, refreshAfterConnectionFailure};
}

export const sessionAccessTimings = {
  failureRefreshCooldownMs: FAILURE_REFRESH_COOLDOWN_MS,
  renewalLeadMs: RENEWAL_LEAD_MS,
  renewalRetryMs: RENEWAL_RETRY_MS,
};

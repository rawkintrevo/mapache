export function derivePiChatSocketUrl(terminalUrl, capabilities = {}) {
  if (!capabilities?.chat) return null;

  try {
    const url = new URL(terminalUrl);
    if (url.protocol === "https:") url.protocol = "wss:";
    else if (url.protocol === "http:") url.protocol = "ws:";
    else return null;

    const accessToken = url.searchParams.get("mapache_access");
    url.pathname = "/chat";
    url.search = accessToken ? `?mapache_access=${encodeURIComponent(accessToken)}` : "";
    url.hash = "";
    return url.toString();
  } catch (error) {
    return null;
  }
}

export function buildPiChatSocketUrl({terminalUrl, capabilities} = {}) {
  return derivePiChatSocketUrl(terminalUrl, capabilities);
}

export const piChatSocketUrl = derivePiChatSocketUrl;

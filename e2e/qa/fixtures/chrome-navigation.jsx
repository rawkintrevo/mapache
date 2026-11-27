import React, {useState} from "react";
import {createRoot} from "react-dom/client";
import {SessionDetail} from "../../../src/components/sessions/SessionDetail.jsx";
import "../../../src/styles.css";

const params = new URLSearchParams(location.search);
const session = {
  id: "fixture", name: "QA workspace", status: "running", serviceUrl: location.origin,
  agentUiVersion: params.has("legacy") ? undefined : "pi-web-ui-v1",
  capabilities: {chrome: false},
};

function Fixture() {
  const [refreshed, setRefreshed] = useState(false);
  const viewerAvailable = params.has("available") || (refreshed && params.has("recover"));
  const accessUrls = {
    agentUrl: new URL("?frame=agent", location.href).href,
    browserUrl: viewerAvailable ? new URL("?frame=viewer", location.href).href : null,
  };
  return <SessionDetail session={session} workspaceId="qa" isRemoteWorkspace
    access={{accessUrls, refresh: () => setRefreshed(true)}} />;
}

const frame = params.get("frame");
const root = createRoot(document.getElementById("root"));
if (frame === "agent") {
  root.render(<button onClick={() => parent.postMessage(
    {type: "mapache.agent.navigate", version: 1, surface: "chrome"}, location.origin,
  )}>Chrome</button>);
  parent.postMessage({type: "mapache.agent.ready", version: 1}, location.origin);
} else if (frame === "viewer") {
  root.render(<h1>Shared Chrome viewer fixture</h1>);
} else {
  root.render(<Fixture />);
}

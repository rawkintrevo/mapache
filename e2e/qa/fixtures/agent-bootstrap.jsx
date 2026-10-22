import React, {useState} from "react";
import {createRoot} from "react-dom/client";
import {PiWebUiCanvas} from "../../../src/components/sessions/PiWebUiCanvas.jsx";
import "../../../src/styles.css";
import "../../../src/components/sessions/SessionDetail.css";

function Fixture() {
  const [renewals, setRenewals] = useState(0);
  return <main style={{height: "90vh", display: "flex", flexDirection: "column"}}>
    <h1>Agent bootstrap recovery QA</h1>
    <p>Access refreshes: {renewals}</p>
    <PiWebUiCanvas sessionName="Recovery fixture"
      url={location.origin + "/e2e/qa/fixtures/agent-bootstrap-frame.html?renewal=" + renewals}
      onAccessRefreshNeeded={() => setRenewals((value) => value + 1)} />
  </main>;
}

createRoot(document.getElementById("root")).render(<Fixture />);

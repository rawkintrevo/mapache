import {ExternalLink} from "lucide-react";
import {Button} from "../common/Button.jsx";

export function BrowserCanvas({sessionName, url}) {
  if (!url) {
    return (
      <div className="terminal-placeholder">
        <p>
          Chrome access is not ready.
          <br />
          <code>browser_access_unavailable</code>
        </p>
      </div>
    );
  }

  return (
    <div className="browser-canvas">
      <div className="browser-canvas__toolbar">
        <span>Persistent Chrome</span>
        <Button
          aria-label="Open Chrome in new tab"
          variant="secondary"
          onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
        >
          <ExternalLink aria-hidden="true" />
          Open Chrome
        </Button>
      </div>
      <iframe
        allow="clipboard-read; clipboard-write; fullscreen"
        className="browser-canvas__frame"
        src={url}
        title={`Chrome ${sessionName}`}
      />
    </div>
  );
}

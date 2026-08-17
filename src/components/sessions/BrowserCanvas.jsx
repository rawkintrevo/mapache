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
      <iframe
        allow="clipboard-read; clipboard-write; fullscreen"
        className="browser-canvas__frame"
        src={url}
        title={`Chrome ${sessionName}`}
      />
    </div>
  );
}

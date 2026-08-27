import "./PiChatCanvas.css";
import {MessageCircle} from "lucide-react";
import {Button} from "../common/Button.jsx";

export function PiChatCanvas({error = "", onOpenTerminal, sessionName, socketUrl}) {
  const unavailable = !socketUrl || error;

  return (
    <section aria-label={`Chat ${sessionName}`} className="pi-chat-canvas">
      <header className="pi-chat-canvas__header">
        <div>
          <span className="pi-chat-canvas__eyebrow">Pi session</span>
          <h2><MessageCircle aria-hidden="true" /> Chat</h2>
        </div>
        <Button variant="secondary" onClick={onOpenTerminal}>
          Open Terminal
        </Button>
      </header>
      <div aria-live="polite" className="pi-chat-canvas__placeholder">
        <strong>{unavailable ? "Chat access is unavailable" : "Chat is ready"}</strong>
        <p>
          {unavailable
            ? "Open Terminal to continue this session and handle any approvals or interactive prompts."
            : "The conversation view will appear here while the shared Pi process remains in Terminal."}
        </p>
        {error ? <code>{error}</code> : null}
      </div>
    </section>
  );
}

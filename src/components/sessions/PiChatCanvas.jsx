import "./PiChatCanvas.css";
import {MessageCircle} from "lucide-react";
import {useEffect, useMemo, useRef, useState} from "react";
import {Button} from "../common/Button.jsx";
import {PiChatMessage} from "./PiChatMessage.jsx";
import {usePiChat} from "./usePiChat.js";

let clientSequence = 0;

export function PiChatCanvas({error = "", onOpenTerminal, sessionId, sessionName, socketUrl}) {
  const chat = usePiChat({enabled: Boolean(socketUrl && sessionId), sessionId, socketUrl});
  const [draft, setDraft] = useState("");
  const [pendingTurns, setPendingTurns] = useState([]);
  const [sending, setSending] = useState(false);
  const [working, setWorking] = useState(false);
  const transcriptRef = useRef(null);
  const shouldStickToBottomRef = useRef(true);
  const assistantIdsSeenRef = useRef(new Set());
  const unavailable = Boolean(error || chat.error || chat.connectionState === "failed" || !socketUrl);
  const displayError = error || chat.error;
  const knownMessageIds = useMemo(() => new Set(chat.messages.map((message) => message.id)), [chat.messages]);

  useEffect(() => {
    setDraft("");
    setPendingTurns([]);
    setSending(false);
    setWorking(false);
    assistantIdsSeenRef.current = new Set();
  }, [sessionId, socketUrl]);

  useEffect(() => {
    setPendingTurns((current) => {
      let changed = false;
      const next = current.map((turn) => {
        if (turn.accepted || !chat.acknowledgements[turn.clientId]) return turn;
        changed = true;
        return {...turn, accepted: true};
      });
      return changed ? next : current;
    });
    if (Object.keys(chat.acknowledgements).length) setWorking(true);
  }, [chat.acknowledgements]);

  useEffect(() => {
    setPendingTurns((current) => {
      const claimedMessageIds = new Set();
      const next = current.filter((turn) => {
        if (!turn.accepted) return true;
        const normalizedText = normalizePrompt(turn.text);
        const match = chat.messages.find((message) =>
          message.role === "user" && normalizePrompt(message.markdown) === normalizedText &&
          !turn.messageIdsAtSubmit.has(message.id) && !claimedMessageIds.has(message.id),
        );
        if (!match) return true;
        claimedMessageIds.add(match.id);
        return false;
      });
      return next.length === current.length ? current : next;
    });
  }, [chat.messages]);

  useEffect(() => {
    if (displayError) {
      setWorking(false);
      return;
    }
    if (chat.status === "working") {
      setWorking(true);
      return;
    }
    if (working && chat.messages.some((message) => message.role === "assistant" && !assistantIdsSeenRef.current.has(message.id))) {
      setWorking(false);
    }
    for (const message of chat.messages) {
      if (message.role === "assistant") assistantIdsSeenRef.current.add(message.id);
    }
  }, [chat.messages, chat.status, displayError, working]);

  useEffect(() => {
    if (!shouldStickToBottomRef.current || !transcriptRef.current) return;
    transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [chat.messages, pendingTurns, working]);

  const submitPrompt = () => {
    const text = draft.trim();
    if (!text || sending || !chat.sendPrompt) return;
    const clientId = createClientId();
    setSending(true);
    const sent = chat.sendPrompt({clientId, text});
    setSending(false);
    if (!sent) return;
    setPendingTurns((current) => [...current, {
      accepted: false,
      clientId,
      messageIdsAtSubmit: new Set(knownMessageIds),
      text,
    }]);
    setDraft("");
  };

  const handleComposerKeyDown = (event) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    submitPrompt();
  };

  const connectionCopy = {
    connecting: "Connecting to Pi…",
    reconnecting: "Connection lost. Reconnecting…",
    failed: "Chat is unavailable.",
  }[chat.connectionState];

  return (
    <section aria-label={`Chat ${sessionName}`} className="pi-chat-canvas">
      <header className="pi-chat-canvas__header">
        <div>
          <span className="pi-chat-canvas__eyebrow">Pi session</span>
          <h2><MessageCircle aria-hidden="true" /> Chat</h2>
        </div>
        <Button aria-label="Open Terminal" variant="secondary" onClick={onOpenTerminal}>
          Open Terminal
        </Button>
      </header>
      <div
        ref={transcriptRef}
        aria-live="polite"
        className="pi-chat-canvas__transcript"
        onScroll={() => {
          const element = transcriptRef.current;
          if (!element) return;
          shouldStickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        }}
      >
        {unavailable || chat.connectionState === "connecting" || chat.connectionState === "reconnecting" || chat.status === "waiting_for_transcript" ? (
          <div className="pi-chat-canvas__status" role="status">
            <strong>{displayError ? "Chat access is unavailable" : chat.status === "waiting_for_transcript" ? "Waiting for Pi’s transcript" : connectionCopy}</strong>
            <p>
              {displayError
                ? "Open Terminal to continue this session and handle approvals or interactive prompts."
                : chat.status === "waiting_for_transcript"
                  ? "Pi will make completed turns available here after they are saved."
                  : "Terminal remains available for approvals, tools, slash commands, and recovery."}
            </p>
            {displayError ? <code>{displayError}</code> : null}
          </div>
        ) : null}
        {chat.messages.map((message) => <PiChatMessage key={message.id} message={message} />)}
        {pendingTurns.map((turn) => (
          <PiChatMessage key={turn.clientId} message={{id: turn.clientId, role: "user", markdown: turn.text, createdAt: null}} />
        ))}
        {working ? <div aria-live="polite" className="pi-chat-canvas__working">Pi is working…</div> : null}
      </div>
      <form className="pi-chat-canvas__composer" onSubmit={(event) => { event.preventDefault(); submitPrompt(); }}>
        <label htmlFor={`pi-chat-prompt-${sessionId}`}>Message Pi</label>
        <textarea
          aria-describedby={`pi-chat-help-${sessionId}`}
          id={`pi-chat-prompt-${sessionId}`}
          placeholder="Ask Pi anything…"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleComposerKeyDown}
        />
        <div className="pi-chat-canvas__composer-footer">
          <span id={`pi-chat-help-${sessionId}`}>Enter to send · Shift+Enter for a new line</span>
          <Button disabled={!draft.trim() || sending} type="submit">Send</Button>
        </div>
      </form>
    </section>
  );
}

function createClientId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  clientSequence += 1;
  return `chat-${Date.now()}-${clientSequence}`;
}

function normalizePrompt(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

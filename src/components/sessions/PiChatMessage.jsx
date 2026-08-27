import "./PiChatMessage.css";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function PiChatMessage({message}) {
  if (!message || !["user", "assistant"].includes(message.role)) return null;
  const isAssistant = message.role === "assistant";

  return (
    <article aria-label={`${isAssistant ? "Assistant" : "You"} message`} className={`pi-chat-message pi-chat-message--${message.role}`}>
      {isAssistant ? (
        <ReactMarkdown
          components={{
            a: SafeLink,
            code: Code,
            pre: CodeBlock,
            table: Table,
          }}
          remarkPlugins={[remarkGfm]}
          skipHtml
        >
          {message.markdown}
        </ReactMarkdown>
      ) : (
        <p className="pi-chat-message__plain">{message.markdown}</p>
      )}
    </article>
  );
}

function SafeLink({children, href, ...props}) {
  const safeHref = href && /^(?:https?:|mailto:)/i.test(href) ? href : undefined;
  return <a {...props} href={safeHref} rel="noreferrer" target="_blank">{children}</a>;
}

function Code({children, className, ...props}) {
  return <code {...props} className={className ? `pi-chat-message__code ${className}` : "pi-chat-message__code"}>{children}</code>;
}

function CodeBlock({children}) {
  return <pre className="pi-chat-message__code-block">{children}</pre>;
}

function Table({children}) {
  return <table className="pi-chat-message__table">{children}</table>;
}

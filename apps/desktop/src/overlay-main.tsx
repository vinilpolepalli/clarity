import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Clock3,
  Copy,
  History,
  Image as ImageIcon,
  LoaderCircle,
  MessageSquarePlus,
  Mic,
  MicOff,
  Move,
  RotateCcw,
  SendHorizontal,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  X
} from "lucide-react";
import { BrandMark } from "./BrandMark";
import type { Conversation, ConversationMessage, HistoryItem, OverlayState } from "./bridge";
import "./styles.css";

const isExpanded = (phase: string) => phase.startsWith("expanded-");

function IconButton({ label, onClick, children, active = false, pressed }: { label: string; onClick: () => void; children: React.ReactNode; active?: boolean; pressed?: boolean }) {
  return (
    <button className={`icon-button ${active ? "is-active" : ""}`} type="button" onClick={onClick} aria-label={label} aria-pressed={pressed} title={label}>
      {children}
    </button>
  );
}

function elapsed(startedAt: number | null, now: number) {
  if (!startedAt) return "";
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function ResponseBody({ text }: { text: string }) {
  const paragraphs = text.split("\n");
  return (
    <div className="response-copy">
      {paragraphs.map((line, index) => line.startsWith("• ")
        ? <div className="response-bullet" key={`${index}-${line}`}><span>•</span><p>{line.slice(2)}</p></div>
        : line ? <p key={`${index}-${line}`}>{line}</p> : <span className="paragraph-gap" key={index} />)}
    </div>
  );
}

function ViewedScreen({ state }: { state: OverlayState }) {
  const attachmentId = state.screenContext.attachmentId;
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    setOpen(false);
    setUnavailable(false);
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
  }, [attachmentId]);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  async function showPreview() {
    if (!attachmentId) return;
    setOpen(true);
    if (previewUrl || loading || unavailable) return;
    setLoading(true);
    try {
      const preview = await window.clarityOverlay.getScreenPreview(attachmentId);
      if (!preview) {
        setUnavailable(true);
        return;
      }
      const bytes = new Uint8Array(preview.bytes);
      setPreviewUrl(URL.createObjectURL(new Blob([bytes], { type: preview.mediaType })));
    } catch {
      setUnavailable(true);
    } finally {
      setLoading(false);
    }
  }

  if (!attachmentId) return null;
  const timestamp = state.screenContext.capturedAt ? new Date(state.screenContext.capturedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "Just now";
  return (
    <div className="screen-disclosure" onMouseEnter={() => void showPreview()} onMouseLeave={() => setOpen(false)}>
      <button type="button" onFocus={() => void showPreview()} onBlur={() => setOpen(false)} onClick={() => void showPreview()} aria-expanded={open}>
        <ImageIcon size={12} /> Viewed screen
      </button>
      {open && (
        <div className="screen-preview-popover" role="dialog" aria-label="Screen used for this response">
          <div className="screen-preview-frame">
            {loading && <span className="screen-preview-message"><LoaderCircle className="spin" size={16} /> Loading preview…</span>}
            {unavailable && <span className="screen-preview-message">Preview is no longer available.</span>}
            {previewUrl && <img src={previewUrl} alt="Screen captured for this response" />}
          </div>
          <footer><span>{timestamp}</span><span>Not saved to history</span></footer>
        </div>
      )}
    </div>
  );
}

function ConversationTurn({ message, state, isLatestAssistant, retry }: { message: ConversationMessage; state: OverlayState; isLatestAssistant: boolean; retry: () => void }) {
  if (message.role === "user") return <div className="chat-turn user-turn"><div className="user-bubble">{message.content}</div></div>;
  const streamingEmpty = message.status === "streaming" && !message.content;
  const viewedCurrentScreen = isLatestAssistant && Boolean(state.screenContext.attachmentId);
  return (
    <div className={`chat-turn assistant-turn ${message.status === "error" ? "has-error" : ""}`}>
      <div className="assistant-meta"><span className="assistant-avatar"><BrandMark size={18} /></span><strong>Clarity</strong>{message.status === "streaming" && <small>Thinking…</small>}</div>
      {streamingEmpty
        ? <div className="typing-indicator" aria-label="Clarity is thinking"><i /><i /><i /></div>
        : message.content && <ResponseBody text={message.content} />}
      {viewedCurrentScreen && <ViewedScreen state={state} />}
      {message.status === "error" && (
        <div className="turn-error">
          <p>{state.error ?? "Clarity couldn’t finish that response."}</p>
          {state.screenContext.status === "permission-blocked" && ["permission-denied", "permission-not-granted"].includes(state.screenContext.errorCode ?? "") && <button className="secondary-button" type="button" onClick={() => void window.clarityOverlay.openScreenPermissionSettings()}>Open Screen Recording Settings</button>}
          {state.screenContext.status === "permission-blocked" && <button className="secondary-button" type="button" onClick={async () => {
            const permission = await window.clarityOverlay.recheckScreenPermission();
            if (permission === "granted") retry();
          }}>Recheck permission</button>}
          {state.screenContext.errorCode === "permission-restricted" && <p className="screen-remediation">This Mac is managed. Ask the device administrator to allow Screen Recording, then try again.</p>}
          {state.screenContext.status === "unsupported" && <button className="secondary-button" type="button" onClick={() => void window.clarityOverlay.openModelSettings()}>Choose a vision model</button>}
          <button className="secondary-button" type="button" onClick={retry}><RotateCcw size={14} /> Try again</button>
        </div>
      )}
      {message.status === "complete" && message.content && <button className="message-copy" type="button" onClick={() => navigator.clipboard.writeText(message.content)}><Copy size={12} /> Copy</button>}
    </div>
  );
}

function ExpandedBody({
  state,
  history,
  dispatch,
  openConversation,
  conversationEnd
}: {
  state: OverlayState;
  history: HistoryItem[];
  dispatch: (action: Record<string, unknown>) => void;
  openConversation: (id: string) => void;
  conversationEnd: React.RefObject<HTMLDivElement | null>;
}) {
  if (state.phase === "expanded-history") {
    return (
      <section className="expanded-content history-list" aria-label="Recent sessions">
        <div className="section-heading"><div><span className="eyebrow">Local history</span><h2>Conversations</h2></div><span className="local-badge">On this Mac</span></div>
        <div className="history-items">
          {history.map((item) => (
            <button className="history-row" key={item.id} type="button" onClick={() => openConversation(item.id)}>
              <span className="history-icon"><Clock3 size={15} /></span>
              <span className="history-text"><strong>{item.title}</strong><small>{item.excerpt || "No messages yet"}</small></span>
              {typeof item.messageCount === "number" && <span className="message-count">{item.messageCount} {item.messageCount === 1 ? "message" : "messages"}</span>}
              <span className="history-time">{item.timestamp}</span>
              <ChevronLeft className="row-chevron" size={14} />
            </button>
          ))}
          {!history.length && <div className="empty-state"><Clock3 size={23} /><h3>No conversations yet</h3><p>Your local conversations will appear here after you ask Clarity something.</p></div>}
        </div>
      </section>
    );
  }

  if (state.phase === "expanded-error") {
    return (
      <section className="expanded-content error-state">
        <span className="error-orb"><X size={20} /></span>
        <span className="eyebrow">Local provider</span>
        <h2>Clarity couldn’t finish that response</h2>
        <p>{state.error}</p>
        <button className="secondary-button" type="button" onClick={() => dispatch({ type: "CLEAR" })}>Dismiss</button>
      </section>
    );
  }

  if (state.phase === "expanded-empty") {
    const loading = Boolean(state.requestId);
    return (
      <section className="expanded-content">
        {state.prompt && <div className="prompt-chip">{state.prompt}</div>}
        {loading ? (
          <div className="thinking-state">
            <span className="thinking-mark"><BrandMark size={24} /></span>
            <div><span className="eyebrow">{state.screenContext.status === "capturing" ? "Capturing current display" : "Working locally"}</span><h2>{state.screenContext.status === "capturing" ? "Looking at your screen…" : "Finding the clearest answer…"}</h2></div>
            <div className="shimmer-lines"><i /><i /><i /></div>
          </div>
        ) : (
          <div className="empty-state suggestions">
            <Sparkles size={24} />
            <h2>What would help right now?</h2>
            <p>Ask about the conversation, turn a decision into next steps, or open a recent local session.</p>
            <div className="suggestion-grid">
              <button type="button" onClick={() => dispatch({ type: "SET_PROMPT", prompt: "What are the next steps?" })}>Find next steps</button>
              <button type="button" onClick={() => dispatch({ type: "SHOW_HISTORY" })}>Open local history</button>
            </div>
          </div>
        )}
      </section>
    );
  }

  let latestAssistantMessageId: string | undefined;
  for (const item of state.messages) {
    if (item.role === "assistant") latestAssistantMessageId = item.id;
  }
  return (
    <section className="expanded-content conversation-state" aria-label="Conversation with Clarity">
      <div className="conversation-heading"><div><span className="eyebrow">Conversation</span><h2>{state.conversationTitle || "Chat with Clarity"}</h2></div><button className="quiet-action" type="button" onClick={() => dispatch({ type: "CLEAR" })}><MessageSquarePlus size={13} /> New chat</button></div>
      <div className="chat-thread" role="log" aria-live="polite" aria-relevant="additions text">
        {state.messages.map((message) => <ConversationTurn key={message.id} message={message} state={state} isLatestAssistant={message.id === latestAssistantMessageId} retry={() => dispatch({ type: "RETRY" })} />)}
        <div ref={conversationEnd} />
      </div>
      <div className="response-footer"><span><ShieldCheck size={13} /> Conversation stored on this Mac</span><span>{state.messages.length} {state.messages.length === 1 ? "message" : "messages"}</span></div>
    </section>
  );
}

function OverlayApp() {
  const [state, setState] = useState<OverlayState | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [draft, setDraft] = useState("");
  const [now, setNow] = useState(Date.now());
  const input = useRef<HTMLInputElement>(null);
  const conversationEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.clarityOverlay.getState().then(setState);
    window.clarityOverlay.getHistory().then(setHistory);
    return window.clarityOverlay.onState((next) => {
      setState(next);
      setDraft(next.prompt);
    });
  }, []);

  useEffect(() => {
    if (!state?.startedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state?.startedAt]);

  useEffect(() => {
    if (state?.phase !== "expanded-response") return;
    conversationEnd.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [state?.messages, state?.phase]);

  const expanded = Boolean(state && isExpanded(state.phase));
  const listening = Boolean(state?.startedAt);
  const duration = useMemo(() => elapsed(state?.startedAt ?? null, now), [state?.startedAt, now]);
  const usesScreen = Boolean(state?.screenContext.enabled);
  const capturingScreen = state?.screenContext.status === "capturing";

  async function dispatch(action: Record<string, unknown>) {
    setState(await window.clarityOverlay.dispatch(action));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const prompt = draft.trim();
    if (!prompt || state?.requestId) return;
    setDraft("");
    void dispatch({ type: "SUBMIT", prompt });
  }

  async function showHistory() {
    setHistory(await window.clarityOverlay.getHistory());
    await dispatch({ type: "SHOW_HISTORY" });
  }

  async function openConversation(id: string) {
    const conversation: Conversation | null = await window.clarityOverlay.getConversation(id);
    if (conversation) await dispatch({ type: "LOAD_CONVERSATION", conversation });
  }

  if (!state || state.phase === "hidden") return null;

  return (
    <main className={`overlay-shell ${expanded ? "is-expanded" : "is-compact"}`} data-phase={state.phase}>
      <div className="overlay-surface">
        <header className="overlay-chrome">
          <div className="drag-handle" title="Drag Clarity"><Move size={12} /><span>Clarity</span></div>
          <div className="session-status">
            {listening ? <><span className="live-dot" /> Listening <b>{duration}</b></> : <><ShieldCheck size={12} /> Private by default</>}
          </div>
          <div className="chrome-actions">
            <IconButton label="Recent conversations" active={state.phase === "expanded-history"} onClick={() => { void showHistory(); }}><History size={13} /></IconButton>
            <IconButton label="Settings" onClick={() => { void window.clarityOverlay.openSettings(); }}><Settings size={13} /></IconButton>
            <IconButton label="Hide overlay" onClick={() => dispatch({ type: "HIDE" })}><X size={13} /></IconButton>
          </div>
        </header>

        {expanded && <ExpandedBody state={state} history={history} dispatch={dispatch} openConversation={(id) => { void openConversation(id); }} conversationEnd={conversationEnd} />}

        <form className="command-row" onSubmit={submit}>
          <span className="command-brand"><BrandMark size={25} /></span>
          <input
            ref={input}
            aria-label="Ask Clarity"
            value={draft}
            onChange={(event) => { setDraft(event.target.value); void window.clarityOverlay.dispatch({ type: "SET_PROMPT", prompt: event.target.value }); }}
            placeholder={usesScreen ? (state.messages.length ? "Ask a follow-up about your screen…" : "Ask anything about your screen…") : state.messages.length ? "Ask a follow-up…" : listening ? "Ask about this conversation…" : "Ask anything…"}
          />
          <IconButton
            label={capturingScreen ? "Capturing current display" : usesScreen ? "Uses screen" : "Does not use screen"}
            active={usesScreen}
            pressed={usesScreen}
            onClick={() => dispatch({ type: "SET_SCREEN_CONTEXT_ENABLED", enabled: !usesScreen })}
          >
            {capturingScreen ? <LoaderCircle className="spin" size={15} /> : <ImageIcon size={15} />}
          </IconButton>
          <span className="mode-pill"><Sparkles size={11} /> Meeting <ChevronDown size={10} /></span>
          <IconButton label={listening ? "Stop listening" : "Start listening"} active={listening} onClick={() => dispatch({ type: listening ? "STOP_LISTENING" : "START_LISTENING" })}>
            {listening ? <Square size={13} fill="currentColor" /> : <Mic size={15} />}
          </IconButton>
          {expanded
            ? <IconButton label="Collapse" onClick={() => dispatch({ type: "COLLAPSE" })}><ChevronUp size={16} /></IconButton>
            : <IconButton label="Expand" onClick={() => dispatch({ type: "EXPAND" })}><ChevronDown size={16} /></IconButton>}
          <button className="send-button" type="submit" aria-label="Send" disabled={!draft.trim() || Boolean(state.requestId)}><SendHorizontal size={14} /></button>
        </form>
      </div>
      {listening && !expanded && <span className="listening-ribbon"><MicOff size={11} /> Click stop to end capture</span>}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<OverlayApp />);

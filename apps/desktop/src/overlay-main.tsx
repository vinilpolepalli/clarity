import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Clock3,
  Copy,
  Grid2X2,
  History,
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
import { ModePicker } from "./ModePicker";
import type { Conversation, ConversationMessage, HistoryItem, ModeModel, OverlayState } from "./bridge";
import "./styles.css";

const isExpanded = (phase: string) => phase.startsWith("expanded-");

function IconButton({ label, onClick, children, active = false }: { label: string; onClick: () => void; children: React.ReactNode; active?: boolean }) {
  return (
    <button className={`icon-button ${active ? "is-active" : ""}`} type="button" onClick={onClick} aria-label={label} title={label}>
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

function ConversationTurn({ message, error, retry }: { message: ConversationMessage; error: string | null; retry: () => void }) {
  if (message.role === "user") return <div className="chat-turn user-turn"><div className="user-bubble">{message.content}</div></div>;
  const streamingEmpty = message.status === "streaming" && !message.content;
  return (
    <div className={`chat-turn assistant-turn ${message.status === "error" ? "has-error" : ""}`}>
      <div className="assistant-meta"><span className="assistant-avatar"><BrandMark size={18} /></span><strong>Clarity</strong>{message.status === "streaming" && <small>Thinking…</small>}</div>
      {streamingEmpty
        ? <div className="typing-indicator" aria-label="Clarity is thinking"><i /><i /><i /></div>
        : message.content && <ResponseBody text={message.content} />}
      {message.status === "error" && (
        <div className="turn-error"><p>{error ?? "Clarity couldn’t finish that response."}</p><button className="secondary-button" type="button" onClick={retry}><RotateCcw size={14} /> Try again</button></div>
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
            <div><span className="eyebrow">Working locally</span><h2>Finding the clearest answer…</h2></div>
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

  return (
    <section className="expanded-content conversation-state" aria-label="Conversation with Clarity">
      <div className="conversation-heading"><div><span className="eyebrow">Conversation</span><h2>{state.conversationTitle || "Chat with Clarity"}</h2></div><button className="quiet-action" type="button" onClick={() => dispatch({ type: "CLEAR" })}><MessageSquarePlus size={13} /> New chat</button></div>
      <div className="chat-thread" role="log" aria-live="polite" aria-relevant="additions text">
        {state.messages.map((message) => <ConversationTurn key={message.id} message={message} error={state.error} retry={() => dispatch({ type: "RETRY" })} />)}
        <div ref={conversationEnd} />
      </div>
      <div className="response-footer"><span><ShieldCheck size={13} /> Conversation stored on this Mac</span><span>{state.messages.length} {state.messages.length === 1 ? "message" : "messages"}</span></div>
    </section>
  );
}

function OverlayApp() {
  const [state, setState] = useState<OverlayState | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [modeModel, setModeModel] = useState<ModeModel | null>(null);
  const [modePicker, setModePicker] = useState<{ placement: "above" | "below"; viewportHeight: number; surfaceOffsetY: number; surfaceHeight: number } | null>(null);
  const [modeError, setModeError] = useState("");
  const [draft, setDraft] = useState("");
  const [now, setNow] = useState(Date.now());
  const input = useRef<HTMLInputElement>(null);
  const modeButton = useRef<HTMLButtonElement>(null);
  const conversationEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.clarityOverlay.getState().then(setState);
    window.clarityOverlay.getHistory().then(setHistory);
    window.clarityOverlay.getModeModel().then(setModeModel);
    const removeStateListener = window.clarityOverlay.onState((next) => {
      setState(next);
      setDraft(next.prompt);
    });
    const removeModeListener = window.clarityOverlay.onModeModel(setModeModel);
    const removePickerListener = window.clarityOverlay.onPickerClosed(() => setModePicker(null));
    return () => { removeStateListener(); removeModeListener(); removePickerListener(); };
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

  async function closeModePicker() {
    setModePicker(null);
    await window.clarityOverlay.closeModePicker();
  }

  async function toggleModePicker() {
    if (modePicker) { await closeModePicker(); return; }
    const anchorRect = modeButton.current?.getBoundingClientRect();
    if (!anchorRect) return;
    setModeError("");
    try {
      const surfaceHeight = window.innerHeight;
      const presentation = await window.clarityOverlay.openModePicker({
        desiredHeight: 420,
        anchorRect: { x: anchorRect.x, y: anchorRect.y, width: anchorRect.width, height: anchorRect.height }
      });
      setModePicker({ ...presentation, surfaceHeight });
    } catch (cause) {
      setModeError(cause instanceof Error ? cause.message : "Could not open modes.");
    }
  }

  async function selectMode(modeId: string) {
    setModeError("");
    try {
      setModeModel(await window.clarityOverlay.setMode(modeId));
      await closeModePicker();
    } catch (cause) {
      setModeError(cause instanceof Error ? cause.message : "Could not save the active mode.");
    }
  }

  async function manageModes() {
    await closeModePicker();
    await window.clarityOverlay.openSettings("modes");
  }

  if (!state || state.phase === "hidden") return null;

  return (
    <main
      className={`overlay-shell ${expanded ? "is-expanded" : "is-compact"} ${modePicker ? "has-mode-picker" : ""}`}
      data-phase={state.phase}
      style={modePicker ? { "--overlay-surface-height": `${modePicker.surfaceHeight}px`, "--overlay-surface-offset": `${modePicker.surfaceOffsetY}px` } as React.CSSProperties : undefined}
    >
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
            placeholder={state.messages.length ? "Ask a follow-up…" : listening ? "Ask about this conversation…" : "Ask anything…"}
          />
          <button ref={modeButton} className={`mode-pill ${modePicker ? "is-active" : ""}`} type="button" aria-haspopup="listbox" aria-expanded={Boolean(modePicker)} aria-label={`Assistant mode: ${modeModel?.modes.find((mode) => mode.id === modeModel.activeModeId)?.label ?? "General"}`} onClick={() => void toggleModePicker()}><Grid2X2 size={12} /><span>{modeModel?.modes.find((mode) => mode.id === modeModel.activeModeId)?.shortLabel ?? "General"}</span><ChevronDown size={10} /></button>
          <IconButton label={listening ? "Stop listening" : "Start listening"} active={listening} onClick={() => dispatch({ type: listening ? "STOP_LISTENING" : "START_LISTENING" })}>
            {listening ? <Square size={13} fill="currentColor" /> : <Mic size={15} />}
          </IconButton>
          {expanded
            ? <IconButton label="Collapse" onClick={() => dispatch({ type: "COLLAPSE" })}><ChevronUp size={16} /></IconButton>
            : <IconButton label="Expand" onClick={() => dispatch({ type: "EXPAND" })}><ChevronDown size={16} /></IconButton>}
          <button className="send-button" type="submit" aria-label="Send" disabled={!draft.trim() || Boolean(state.requestId)}><SendHorizontal size={14} /></button>
        </form>
      </div>
      {modePicker && modeModel && <ModePicker anchorElement={modeButton.current} model={modeModel} placement={modePicker.placement} viewportHeight={modePicker.viewportHeight} error={modeError} onClose={() => void closeModePicker()} onManage={() => void manageModes()} onSelect={(modeId) => void selectMode(modeId)} />}
      {listening && !expanded && <span className="listening-ribbon"><MicOff size={11} /> Click stop to end capture</span>}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<OverlayApp />);

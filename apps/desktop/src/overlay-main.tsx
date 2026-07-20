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
import type { HistoryItem, OverlayState } from "./bridge";
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

function ExpandedBody({ state, history, dispatch }: { state: OverlayState; history: HistoryItem[]; dispatch: (action: Record<string, unknown>) => void }) {
  if (state.phase === "expanded-history") {
    const selected = history.find((item) => item.id === state.selectedHistoryId);
    if (selected) {
      return (
        <section className="expanded-content history-detail" aria-label="Session detail">
          <button className="back-button" type="button" onClick={() => dispatch({ type: "SHOW_HISTORY" })}><ChevronLeft size={14} /> Sessions</button>
          <div className="detail-heading"><div><span className="eyebrow">{selected.timestamp}</span><h2>{selected.title}</h2></div><ShieldCheck size={17} /></div>
          {selected.response ? <ResponseBody text={selected.response} /> : <div className="empty-state"><Clock3 size={23} /><h3>No transcript for this session</h3><p>Clarity did not detect enough conversation to prepare a response.</p></div>}
        </section>
      );
    }
    return (
      <section className="expanded-content history-list" aria-label="Recent sessions">
        <div className="section-heading"><div><span className="eyebrow">Local history</span><h2>Recent sessions</h2></div><span className="local-badge">On this Mac</span></div>
        <div className="history-items">
          {history.map((item) => (
            <button className="history-row" key={item.id} type="button" onClick={() => dispatch({ type: "SELECT_HISTORY", id: item.id })}>
              <span className="history-icon"><Clock3 size={15} /></span>
              <span className="history-text"><strong>{item.title}</strong><small>{item.excerpt}</small></span>
              <span className="history-time">{item.timestamp}</span>
              <ChevronLeft className="row-chevron" size={14} />
            </button>
          ))}
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
        <ViewedScreen state={state} />
        {state.screenContext.status === "permission-blocked" && ["permission-denied", "permission-not-granted"].includes(state.screenContext.errorCode ?? "") && <button className="secondary-button" type="button" onClick={() => void window.clarityOverlay.openScreenPermissionSettings()}>Open Screen Recording Settings</button>}
        {state.screenContext.status === "permission-blocked" && <button className="secondary-button" type="button" onClick={async () => {
          const permission = await window.clarityOverlay.recheckScreenPermission();
          if (permission === "granted") dispatch({ type: "SUBMIT", prompt: state.prompt });
        }}>Recheck permission</button>}
        {state.screenContext.errorCode === "permission-restricted" && <p className="screen-remediation">This Mac is managed. Ask the device administrator to allow Screen Recording, then try again.</p>}
        {state.screenContext.status === "unsupported" && <button className="secondary-button" type="button" onClick={() => void window.clarityOverlay.openModelSettings()}>Choose a vision model</button>}
        <button className="secondary-button" type="button" onClick={() => dispatch({ type: "SUBMIT", prompt: state.prompt })}><RotateCcw size={14} /> Try again</button>
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

  return (
    <section className="expanded-content response-state">
      <div className="response-heading"><div><span className="eyebrow">Clarity</span><h2>A focused answer</h2></div><button className="quiet-action" type="button" onClick={() => navigator.clipboard.writeText(state.response)}><Copy size={13} /> Copy</button></div>
      <ViewedScreen state={state} />
      <ResponseBody text={state.response} />
      <div className="response-footer"><span><ShieldCheck size={13} /> Generated on this Mac</span><button type="button" onClick={() => dispatch({ type: "CLEAR" })}>New question</button></div>
    </section>
  );
}

function OverlayApp() {
  const [state, setState] = useState<OverlayState | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [draft, setDraft] = useState("");
  const [now, setNow] = useState(Date.now());
  const input = useRef<HTMLInputElement>(null);

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
    dispatch({ type: "SUBMIT", prompt: draft });
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
            <IconButton label="Recent sessions" active={state.phase === "expanded-history"} onClick={() => dispatch({ type: "SHOW_HISTORY" })}><History size={13} /></IconButton>
            <IconButton label="Settings" onClick={() => { void window.clarityOverlay.openSettings(); }}><Settings size={13} /></IconButton>
            <IconButton label="Hide overlay" onClick={() => dispatch({ type: "HIDE" })}><X size={13} /></IconButton>
          </div>
        </header>

        {expanded && <ExpandedBody state={state} history={history} dispatch={dispatch} />}

        <form className="command-row" onSubmit={submit}>
          <span className="command-brand"><BrandMark size={25} /></span>
          <input
            ref={input}
            aria-label="Ask Clarity"
            value={draft}
            onChange={(event) => { setDraft(event.target.value); void window.clarityOverlay.dispatch({ type: "SET_PROMPT", prompt: event.target.value }); }}
            placeholder={usesScreen ? "Ask anything about your screen…" : listening ? "Ask about this conversation…" : "Ask anything…"}
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
          <button className="send-button" type="submit" aria-label="Send" disabled={!draft.trim()}><SendHorizontal size={14} /></button>
        </form>
      </div>
      {listening && !expanded && <span className="listening-ribbon"><MicOff size={11} /> Click stop to end capture</span>}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<OverlayApp />);

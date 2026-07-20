import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Accessibility,
  AudioLines,
  BadgeInfo,
  CalendarDays,
  Check,
  ChevronRight,
  CircleUserRound,
  Cloud,
  Command,
  ExternalLink,
  FileText,
  Gauge,
  Headphones,
  Info,
  KeyRound,
  Languages,
  Laptop,
  Link2,
  LockKeyhole,
  Mic,
  MonitorUp,
  MoonStar,
  Radio,
  RefreshCw,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Volume2,
  WandSparkles,
  WifiOff,
  X
} from "lucide-react";
import { BrandMark } from "./BrandMark";
import type { Preferences, ProviderModel, SettingsModel } from "./bridge";
import "./styles.css";

type TabId = "general" | "models" | "audio" | "modes" | "keybindings" | "profile" | "privacy" | "integrations" | "about";

const tabs: Array<{ id: TabId; label: string; icon: React.ReactNode }> = [
  { id: "general", label: "General", icon: <Settings2 size={16} /> },
  { id: "models", label: "Models", icon: <WandSparkles size={16} /> },
  { id: "audio", label: "Audio", icon: <AudioLines size={16} /> },
  { id: "modes", label: "Modes", icon: <Gauge size={16} /> },
  { id: "keybindings", label: "Keys", icon: <Command size={16} /> },
  { id: "profile", label: "Cloud", icon: <CircleUserRound size={16} /> },
  { id: "privacy", label: "Privacy", icon: <LockKeyhole size={16} /> },
  { id: "integrations", label: "Integrations", icon: <Link2 size={16} /> },
  { id: "about", label: "About", icon: <Info size={16} /> }
];

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <button className={`toggle ${checked ? "is-on" : ""}`} type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

function Select({ value, onChange, options, label }: { value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }>; label: string }) {
  return <select className="settings-select" aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
}

function SettingRow({ icon, title, description, children }: { icon: React.ReactNode; title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="setting-row">
      <span className="setting-icon">{icon}</span>
      <div className="setting-copy"><strong>{title}</strong><p>{description}</p></div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return <section className="settings-section"><header><h2>{title}</h2>{description && <p>{description}</p>}</header><div className="settings-card">{children}</div></section>;
}

function PermissionBadge({ status }: { status: string }) {
  const granted = status === "granted";
  return <span className={`permission-badge ${granted ? "is-granted" : ""}`}>{granted ? <Check size={12} /> : <span className="status-dot" />}{granted ? "Allowed" : status.replaceAll("-", " ")}</span>;
}

function WelcomePreview({ step }: { step: number }) {
  return (
    <div className="onboarding-preview" aria-hidden="true">
      <div className="preview-glow" />
      <div className="preview-menu"><span /><span /><span /></div>
      {step === 0 && (
        <div className="preview-overlay">
          <div className="preview-chrome"><span><BrandMark size={15} /> Clarity</span><i>Private by default</i></div>
          <div className="preview-answer"><small>CLARITY</small><strong>Your meeting, made actionable.</strong><p>Capture decisions and next steps while provider keys and inference stay on this Mac.</p><div><span /><span /><span /></div></div>
          <div className="preview-command"><BrandMark size={19} /><span>Ask about this conversation…</span><b>⌘↵</b></div>
        </div>
      )}
      {step === 1 && (
        <div className="system-permission-preview">
          <div className="system-dialog"><span className="system-app-icon"><BrandMark size={27} /></span><h3>Clarity needs your permission</h3><p>macOS keeps you in control. You can change every permission later in System Settings.</p><div><button>Don’t Allow</button><button className="system-primary">Allow</button></div></div>
        </div>
      )}
      {step === 2 && (
        <div className="local-architecture-preview">
          <div className="architecture-node primary"><Laptop size={19} /><span><strong>This Mac</strong><small>Capture, inference, storage</small></span></div>
          <div className="architecture-line" />
          <div className="architecture-node"><KeyRound size={18} /><span><strong>Keychain</strong><small>Your provider keys</small></span></div>
          <div className="architecture-node muted"><Cloud size={18} /><span><strong>Optional cloud</strong><small>Off until you enable it</small></span></div>
        </div>
      )}
      <div className="preview-caption"><span>CLARITY FOR MAC</span><p>{step === 0 ? "A quiet surface that stays within reach." : step === 1 ? "Clear, reversible permission choices." : "Local-first by default."}</p></div>
    </div>
  );
}

function Onboarding({ model, onComplete, onModel }: { model: SettingsModel; onComplete: () => void; onModel: (model: SettingsModel) => void }) {
  const [step, setStep] = useState(0);
  const [requesting, setRequesting] = useState<string | null>(null);
  const permissions = model.permissions;
  const permissionItems = [
    { id: "accessibility" as const, icon: <Accessibility size={18} />, title: "Accessibility", copy: "Lets the global shortcut bring Clarity forward while you work." },
    { id: "microphone" as const, icon: <Mic size={18} />, title: "Microphone", copy: "Captures your voice only while listening is visibly active." },
    { id: "screen" as const, icon: <MonitorUp size={18} />, title: "Screen & system audio", copy: "Captures meeting audio. Screen pixels are never stored by default." }
  ];

  async function request(capability: "accessibility" | "microphone" | "screen") {
    setRequesting(capability);
    await window.claritySettings.requestPermission(capability);
    onModel(await window.claritySettings.getModel());
    setRequesting(null);
  }

  return (
    <main className="onboarding-shell">
      <section className="onboarding-copy-panel">
        <div className="window-drag" />
        <div className="onboarding-brand"><BrandMark size={25} /><span>Clarity</span><small>Open source</small></div>
        <div className="onboarding-content">
          <div className="step-count">0{step + 1} <span>/ 03</span></div>
          {step === 0 && <><span className="eyebrow">Welcome</span><h1>Stay present.<br />Keep the clarity.</h1><p className="onboarding-lede">Clarity is a private, local-first meeting copilot. Ask questions, preserve decisions, and prepare follow-ups without sending provider keys to our cloud.</p><div className="trust-row"><ShieldCheck size={15} /> Open source · BYOK · local storage</div></>}
          {step === 1 && <><span className="eyebrow">Permissions</span><h1>You remain<br />in control.</h1><p className="onboarding-lede">Grant only what you need. Clarity shows when capture is active, handles denial safely, and never promises guaranteed invisibility.</p><div className="permission-list">{permissionItems.map((item) => <button type="button" key={item.id} onClick={() => request(item.id)}><span className="permission-icon">{item.icon}</span><span><strong>{item.title}</strong><small>{item.copy}</small></span>{requesting === item.id ? <RefreshCw className="spin" size={15} /> : <PermissionBadge status={permissions[item.id]} />}</button>)}</div></>}
          {step === 2 && <><span className="eyebrow">Local first</span><h1>Choose your<br />intelligence.</h1><p className="onboarding-lede">Start with the built-in offline demo. Add NVIDIA NIM, OpenAI, or Anthropic later; keys are stored in macOS Keychain and inference stays on this desktop.</p><div className="provider-choice"><span><WandSparkles size={18} /><span><strong>Clarity Demo</strong><small>No key required</small></span></span><Check size={16} /></div><p className="fine-print"><WifiOff size={13} /> Local features work without an account or network connection.</p></>}
        </div>
        <footer className="onboarding-actions">
          <div className="step-dots">{[0, 1, 2].map((index) => <i className={index === step ? "is-active" : ""} key={index} />)}</div>
          <div>{step > 0 && <button className="text-button" type="button" onClick={() => setStep(step - 1)}>Back</button>}<button className="primary-button" type="button" onClick={() => step === 2 ? onComplete() : setStep(step + 1)}>{step === 0 ? "Continue" : step === 1 ? "Continue with current access" : "Open Clarity"}<ChevronRight size={15} /></button></div>
        </footer>
      </section>
      <WelcomePreview step={step} />
    </main>
  );
}

function GeneralPage({ preferences, update }: PageProps) {
  return <><PageTitle eyebrow="Clarity for Mac" title="General" description="Control how Clarity launches, appears, and communicates." />
    <Section title="Startup">
      <SettingRow icon={<Laptop size={16} />} title="Launch at login" description="Start Clarity when you sign in to this Mac."><Toggle label="Launch at login" checked={preferences.launchAtLogin} onChange={(value) => update({ launchAtLogin: value })} /></SettingRow>
      <SettingRow icon={<Sparkles size={16} />} title="Show the overlay at launch" description="Keep Clarity ready without opening Settings."><Toggle label="Show overlay at launch" checked={preferences.launchOverlayAtLogin} onChange={(value) => update({ launchOverlayAtLogin: value })} /></SettingRow>
    </Section>
    <Section title="Appearance" description="Liquid Glass is intentionally deferred until the observable behavior is stable.">
      <SettingRow icon={<MoonStar size={16} />} title="Reduce transparency" description="Use a fully opaque overlay surface for legibility."><Toggle label="Reduce transparency" checked={preferences.reduceTransparency} onChange={(value) => update({ reduceTransparency: value })} /></SettingRow>
      <SettingRow icon={<Gauge size={16} />} title="Reduce motion" description="Make reveal and bounds transitions immediate."><Toggle label="Reduce motion" checked={preferences.reduceMotion} onChange={(value) => update({ reduceMotion: value })} /></SettingRow>
    </Section>
    <Section title="Language">
      <SettingRow icon={<Languages size={16} />} title="Transcription language" description="Auto-detect is recommended for mixed-language meetings."><Select label="Transcription language" value={preferences.transcriptLanguage} onChange={(value) => update({ transcriptLanguage: value })} options={[{ value: "auto", label: "Auto-detect" }, { value: "en", label: "English" }, { value: "es", label: "Spanish" }, { value: "hi", label: "Hindi" }]} /></SettingRow>
      <SettingRow icon={<FileText size={16} />} title="Answer language" description="The language used for answers and artifacts."><Select label="Answer language" value={preferences.outputLanguage} onChange={(value) => update({ outputLanguage: value })} options={["English", "Spanish", "Hindi", "French"].map((value) => ({ value, label: value }))} /></SettingRow>
    </Section></>;
}

interface PageProps { preferences: Preferences; model: SettingsModel; update: (patch: Partial<Preferences>) => Promise<void>; setModel: (model: SettingsModel) => void }

const DEFAULT_PROVIDER_MODELS: Record<string, string> = {
  demo: "clarity-demo",
  nvidia: "deepseek-ai/deepseek-v4-flash",
  openai: "gpt-4.1-mini",
  anthropic: "claude-sonnet-4-5"
};

function ModelsPage({ preferences, model, update, setModel }: PageProps) {
  const [key, setKey] = useState("");
  const [message, setMessage] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [discoveredModels, setDiscoveredModels] = useState<ProviderModel[]>([]);
  const [discoveryState, setDiscoveryState] = useState<"idle" | "loading" | "error">("idle");
  const [discoveryMessage, setDiscoveryMessage] = useState("");
  const provider = preferences.provider;
  const needsKey = provider !== "demo";
  const hostedProvider = provider as keyof Preferences["customModels"];
  const savedCustomModels = preferences.customModels[hostedProvider] ?? [];
  const connection = model.providerConnection;
  const modelOptions = useMemo(() => {
    const choices = new Map<string, string>();
    for (const candidate of model.providerCatalog.curated) choices.set(candidate.id, `${candidate.label} · ${candidate.description}`);
    for (const candidate of discoveredModels) if (!choices.has(candidate.id)) choices.set(candidate.id, candidate.id);
    for (const id of savedCustomModels) if (!choices.has(id)) choices.set(id, `${id} · Custom`);
    if (preferences.model && !choices.has(preferences.model)) choices.set(preferences.model, `${preferences.model} · Selected`);
    return [...choices].map(([value, label]) => ({ value, label }));
  }, [discoveredModels, model.providerCatalog.curated, preferences.model, savedCustomModels]);

  useEffect(() => {
    setDiscoveredModels([]);
    setDiscoveryState("idle");
    setDiscoveryMessage("");
    setMessage("");
  }, [provider]);

  async function saveKey() {
    try {
      setModel(await window.claritySettings.saveProviderKey(provider, key));
      setKey(""); setMessage("Saved securely in macOS Keychain.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save the key."); }
  }

  async function refreshModels() {
    setDiscoveryState("loading");
    setDiscoveryMessage("");
    const result = await window.claritySettings.listProviderModels();
    if (result.ok) {
      setDiscoveredModels(result.models);
      setDiscoveryState("idle");
      setDiscoveryMessage(result.models.length ? `Found ${result.models.length} models from the provider.` : "The provider returned no models; curated and custom models remain available.");
    } else {
      setDiscoveryState("error");
      setDiscoveryMessage(result.error?.message ?? "Could not refresh models; curated and custom models remain available.");
    }
  }

  async function addCustomModel() {
    const id = customModel.trim();
    if (!id || id.length > 160 || /\s/.test(id)) {
      setDiscoveryState("error");
      setDiscoveryMessage("Enter a model ID without spaces, up to 160 characters.");
      return;
    }
    if (!savedCustomModels.includes(id) && savedCustomModels.length >= 20) {
      setDiscoveryState("error");
      setDiscoveryMessage("Remove a saved custom model before adding another one.");
      return;
    }
    const next = [...new Set([...savedCustomModels, id])].slice(0, 20);
    await update({ customModels: { ...preferences.customModels, [provider]: next }, model: id });
    setCustomModel("");
    setDiscoveryState("idle");
    setDiscoveryMessage(`Added ${id} and selected it.`);
  }

  async function removeCustomModel(id: string) {
    const next = savedCustomModels.filter((candidate) => candidate !== id);
    const patch: Partial<Preferences> = { customModels: { ...preferences.customModels, [provider]: next } };
    if (preferences.model === id) patch.model = model.providerCatalog.curated[0]?.id ?? DEFAULT_PROVIDER_MODELS[provider];
    await update(patch);
  }

  async function testProvider() {
    setMessage("");
    setModel(await window.claritySettings.testProviderConnection());
  }

  const testedTime = connection.testedAt
    ? new Date(connection.testedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : null;
  const connectionTitle = connection.state === "connected"
    ? "Selected model is connected"
    : connection.state === "testing" ? "Testing the selected model…"
      : connection.state === "error" ? "Connection test failed" : "Not tested for this configuration";
  const connectionCopy = connection.state === "connected"
    ? `${connection.model} answered at ${testedTime}${connection.latencyMs !== null ? ` in ${connection.latencyMs} ms` : ""}.`
    : connection.state === "testing" ? "Clarity is sending a tiny non-streaming request from this Mac."
      : connection.state === "error" ? connection.error?.message ?? "The provider could not verify this configuration."
        : "Test after saving a key. Changing the provider, model, or key clears prior evidence.";

  return <><PageTitle eyebrow="Bring your own key" title="Models" description="Inference runs from this desktop. Provider credentials are never synced." />
    <Section title="Provider">
      <SettingRow icon={<WandSparkles size={16} />} title="Inference provider" description="The demo provider is deterministic and works offline."><Select label="Provider" value={provider} onChange={(value) => update({ provider: value, model: DEFAULT_PROVIDER_MODELS[value] })} options={[{ value: "demo", label: "Clarity Demo" }, { value: "nvidia", label: "NVIDIA NIM" }, { value: "openai", label: "OpenAI" }, { value: "anthropic", label: "Anthropic" }]} /></SettingRow>
      <SettingRow icon={<Sparkles size={16} />} title="Model" description="Curated models appear in Clarity's preferred order; refreshed and custom models follow."><span className="model-picker-actions"><Select label="Model" value={preferences.model} onChange={(value) => update({ model: value })} options={modelOptions} />{needsKey && model.providerCatalog.discoverySupported && <button className="secondary-button compact-button" type="button" disabled={!model.keyConfigured[provider] || discoveryState === "loading"} onClick={refreshModels}><RefreshCw className={discoveryState === "loading" ? "spin" : ""} size={13} />{discoveryState === "loading" ? "Refreshing" : "Refresh"}</button>}</span></SettingRow>
      {needsKey && <div className="custom-model-panel"><div><input className="settings-input" value={customModel} onChange={(event) => setCustomModel(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void addCustomModel(); }} placeholder="publisher/model-id" aria-label="Custom model ID" /><button className="secondary-button" type="button" disabled={!customModel.trim()} onClick={addCustomModel}>Add custom model</button></div>{savedCustomModels.length > 0 && <div className="custom-model-list" aria-label="Saved custom models">{savedCustomModels.map((id) => <span key={id}><small title={id}>{id}</small><button type="button" aria-label={`Remove ${id}`} onClick={() => removeCustomModel(id)}><X size={11} /></button></span>)}</div>}{discoveryMessage && <p className={discoveryState === "error" ? "is-error" : ""}>{discoveryMessage}</p>}</div>}
    </Section>
    {needsKey && <Section title="Provider key" description="Clarity stores this secret directly in macOS Keychain. It is never written to preferences or logs.">
      <div className="credential-panel"><div><span className={`credential-status ${model.keyConfigured[provider] ? "is-set" : ""}`}><KeyRound size={14} />{model.keyConfigured[provider] ? "Key configured" : "No key configured"}</span><input className="settings-input" type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} placeholder={`Paste ${provider} API key`} /></div><button className="secondary-button" type="button" disabled={!key.trim()} onClick={saveKey}>Save to Keychain</button>{model.keyConfigured[provider] && <button className="danger-text-button" type="button" onClick={async () => setModel(await window.claritySettings.deleteProviderKey(provider))}>Remove</button>}</div>{message && <p className="inline-message">{message}</p>}
    </Section>}
    {needsKey && <Section title="Connection test" description="This makes one tiny request to the selected model. A successful result proves the key, endpoint, and model work together.">
      <div className={`provider-connection is-${connection.state}`}><span><i /><span><strong>{connectionTitle}</strong><small>{connectionCopy}</small></span></span><button className="secondary-button" type="button" disabled={!model.keyConfigured[provider] || !preferences.model || connection.state === "testing"} onClick={testProvider}>{connection.state === "testing" ? <RefreshCw className="spin" size={13} /> : <Radio size={13} />}{connection.state === "testing" ? "Testing" : connection.state === "connected" ? "Test again" : "Test connection"}</button></div>
    </Section>}
    <div className="callout"><ShieldCheck size={17} /><div><strong>Desktop-side inference boundary</strong><p>Optional cloud features may sync encrypted artifacts, but they do not receive your provider key or run inference in v1.</p></div></div></>;
}

function AudioPage({ preferences, model, update }: PageProps) {
  return <><PageTitle eyebrow="Capture" title="Audio" description="Choose explicit sources and see permission health before a meeting." />
    <Section title="Sources">
      <SettingRow icon={<Mic size={16} />} title="Microphone" description="Default macOS input device."><span className="row-combo"><Select label="Microphone" value={preferences.microphoneId} onChange={(value) => update({ microphoneId: value })} options={[{ value: "default", label: "System default" }]} /><PermissionBadge status={model.permissions.microphone} /></span></SettingRow>
      <SettingRow icon={<Volume2 size={16} />} title="System audio" description="Capture meeting audio through ScreenCaptureKit."><span className="row-combo"><Toggle label="Capture system audio" checked={preferences.captureSystemAudio} onChange={(value) => update({ captureSystemAudio: value })} /><PermissionBadge status={model.permissions.screen} /></span></SettingRow>
    </Section>
    <Section title="Health check">
      <div className="meter-demo"><span><Headphones size={17} /> Input level</span><div className="meter-track"><i /><i /><i /><i /><i /><i /></div><button className="secondary-button" type="button">Test microphone</button></div>
      <div className="diagnostic-row"><Radio size={15} /><span><strong>Capture is stopped</strong><small>Clarity never starts listening from the Settings window.</small></span></div>
    </Section></>;
}

function ModesPage({ preferences, update }: PageProps) {
  const modes = [
    { id: "meeting", title: "Meeting", copy: "Decisions, questions, owners, and follow-ups.", icon: <CircleUserRound size={18} /> },
    { id: "interview", title: "Interview", copy: "Concise prompts and evidence-backed notes.", icon: <Mic size={18} /> },
    { id: "lecture", title: "Lecture", copy: "Definitions, explanations, and study structure.", icon: <FileText size={18} /> }
  ];
  return <><PageTitle eyebrow="Context presets" title="Modes" description="Tune the structure of help without changing your provider or privacy boundary." /><div className="mode-grid">{modes.map((mode) => <button className={`mode-card ${preferences.mode === mode.id ? "is-selected" : ""}`} key={mode.id} type="button" onClick={() => update({ mode: mode.id })}><span>{mode.icon}</span><div><strong>{mode.title}</strong><p>{mode.copy}</p></div>{preferences.mode === mode.id && <Check size={15} />}</button>)}</div><Section title="Mode behavior"><SettingRow icon={<Sparkles size={16} />} title="Active preset" description="Applied to new questions and session artifacts."><span className="value-chip">{preferences.mode}</span></SettingRow></Section></>;
}

function KeybindingsPage({ preferences }: PageProps) {
  const rows = [{ key: "toggleOverlay", label: "Show or hide overlay" }, { key: "toggleListening", label: "Start or stop listening" }, { key: "submit", label: "Submit a question" }];
  return <><PageTitle eyebrow="Keyboard" title="Keybindings" description="Global shortcuts keep the overlay reachable while another app is active." /><Section title="Global shortcuts">{rows.map((row) => <SettingRow key={row.key} icon={<Command size={16} />} title={row.label} description="Available while Clarity is running."><kbd>{preferences.keybindings[row.key]?.replaceAll("CommandOrControl", "⌘").replaceAll("+", " ")}</kbd></SettingRow>)}</Section><div className="callout subtle"><Accessibility size={17} /><div><strong>Accessibility permission</strong><p>macOS may require Accessibility access for reliable global shortcut behavior.</p></div></div></>;
}

function CloudPage({ preferences, update }: PageProps) {
  return <><PageTitle eyebrow="Optional account" title="Profile & Cloud" description="Everything local works without signing in. Cloud is opt-in and off by default." /><Section title="Cloud boundary"><SettingRow icon={<Cloud size={16} />} title="Encrypted cloud sync" description="Sync encrypted artifacts for search and display on another device. Provider keys and inference stay on this Mac."><Toggle label="Encrypted cloud sync" checked={preferences.cloudEnabled} onChange={(value) => update({ cloudEnabled: value })} /></SettingRow></Section>{preferences.cloudEnabled ? <div className="callout warning"><BadgeInfo size={17} /><div><strong>Backend setup required</strong><p>Connect a self-hosted Supabase project before sign-in. No artifact leaves this Mac until a destination and encryption key are configured.</p></div></div> : <div className="offline-profile"><WifiOff size={24} /><h3>Local-only mode</h3><p>Your sessions, search index, and exports remain on this Mac.</p></div>}</>;
}

function PrivacyPage({ preferences, update }: PageProps) {
  return <><PageTitle eyebrow="Best-effort protection" title="Privacy" description="Clarity minimizes exposure and explains OS limits honestly. No desktop app can guarantee invisibility." /><Section title="Overlay protection"><SettingRow icon={<ShieldCheck size={16} />} title="Protect overlay content" description="Ask macOS to omit the overlay from many common captures. Some apps and external cameras may still record it."><Toggle label="Protect overlay content" checked={preferences.protectOverlayContent} onChange={(value) => update({ protectOverlayContent: value })} /></SettingRow></Section><Section title="Local data"><SettingRow icon={<Laptop size={16} />} title="Session storage" description="Transcripts, answers, and search index live in your user data directory."><span className="local-badge">On this Mac</span></SettingRow><SettingRow icon={<RotateCcw size={16} />} title="Retention" description="Automatic deletion policy for completed sessions."><Select label="Retention" value="forever" onChange={() => {}} options={[{ value: "forever", label: "Keep until deleted" }, { value: "30", label: "30 days" }, { value: "7", label: "7 days" }]} /></SettingRow></Section><div className="callout warning"><MonitorUp size={17} /><div><strong>Screen pixels are not stored by default</strong><p>Screen Recording permission is used for system audio. Capture is visibly indicated, and denial leaves the rest of the app usable.</p></div></div></>;
}

function IntegrationsPage({ preferences, update }: PageProps) {
  const setIntegration = (key: "notion" | "googleCalendar", value: boolean) => update({ integrations: { ...preferences.integrations, [key]: value } });
  return <><PageTitle eyebrow="Explicit connections" title="Integrations" description="Every integration has its own grant and is disabled by default." /><Section title="Available"><SettingRow icon={<CalendarDays size={16} />} title="Google Calendar" description="Read selected event metadata for meeting context."><Toggle label="Google Calendar" checked={preferences.integrations.googleCalendar} onChange={(value) => setIntegration("googleCalendar", value)} /></SettingRow><SettingRow icon={<FileText size={16} />} title="Notion" description="Export a chosen summary after you review it."><Toggle label="Notion" checked={preferences.integrations.notion} onChange={(value) => setIntegration("notion", value)} /></SettingRow></Section><div className="callout"><LockKeyhole size={17} /><div><strong>No background export</strong><p>Clarity asks for a destination and confirmation before sending an artifact.</p></div></div></>;
}

function AboutPage({ model }: PageProps) {
  return <><PageTitle eyebrow="Open source" title="About Clarity" description="A local-first meeting copilot built for transparent operation and user control." /><div className="about-hero"><BrandMark size={56} /><div><h2>Clarity</h2><p>Version {model.app.version} · {model.app.packaged ? "Packaged build" : "Development build"}</p></div></div><Section title="Project"><SettingRow icon={<RefreshCw size={16} />} title="Updates" description="Release checks never upload session content."><button className="secondary-button" type="button">Check for updates</button></SettingRow><SettingRow icon={<FileText size={16} />} title="License" description="GNU Affero General Public License v3."><button className="link-button" type="button" onClick={() => window.claritySettings.openExternal("https://www.gnu.org/licenses/agpl-3.0.html")}>View license <ExternalLink size={12} /></button></SettingRow><SettingRow icon={<Sparkles size={16} />} title="Source code" description="Audit, fork, and improve Clarity."><button className="link-button" type="button" onClick={() => window.claritySettings.openExternal("https://github.com/vinilpolepalli/clarity")}>Open repository <ExternalLink size={12} /></button></SettingRow></Section><p className="about-note">Clarity uses best-effort content protection. It does not claim to be undetectable or invisible to every capture method.</p></>;
}

function PageTitle({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <header className="page-title"><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></header>;
}

function SettingsApp() {
  const [model, setModel] = useState<SettingsModel | null>(null);
  useEffect(() => { window.claritySettings.getModel().then(setModel); return window.claritySettings.onModel(setModel); }, []);
  const activeTab = (model?.preferences.selectedSettingsTab ?? "general") as TabId;
  const page = useMemo(() => {
    if (!model) return null;
    const props: PageProps = { preferences: model.preferences, model, setModel, update: async (patch) => setModel(await window.claritySettings.update(patch)) };
    switch (activeTab) {
      case "models": return <ModelsPage {...props} />;
      case "audio": return <AudioPage {...props} />;
      case "modes": return <ModesPage {...props} />;
      case "keybindings": return <KeybindingsPage {...props} />;
      case "profile": return <CloudPage {...props} />;
      case "privacy": return <PrivacyPage {...props} />;
      case "integrations": return <IntegrationsPage {...props} />;
      case "about": return <AboutPage {...props} />;
      default: return <GeneralPage {...props} />;
    }
  }, [activeTab, model]);
  if (!model) return <div className="settings-loading"><BrandMark size={31} /><span>Opening Clarity…</span></div>;
  if (model.onboarding) return <Onboarding model={model} onModel={setModel} onComplete={() => window.claritySettings.completeOnboarding()} />;
  return (
    <main className="settings-shell">
      <div className="settings-titlebar window-drag"><span><BrandMark size={17} /> Clarity</span><small>Settings</small></div>
      <nav className="settings-tabs" aria-label="Settings categories">{tabs.map((tab) => <button className={activeTab === tab.id ? "is-active" : ""} type="button" key={tab.id} onClick={() => window.claritySettings.update({ selectedSettingsTab: tab.id })}><span>{tab.icon}</span><small>{tab.label}</small></button>)}</nav>
      <div className="settings-content" key={activeTab}>{page}<footer className="settings-footer"><span><ShieldCheck size={12} /> Local first</span><span>Clarity {model.app.version}</span></footer></div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<SettingsApp />);

export type OverlayPhase =
  | "hidden"
  | "compact-idle"
  | "compact-listening"
  | "expanded-empty"
  | "expanded-response"
  | "expanded-error"
  | "expanded-history";

export interface OverlayState {
  version: 2;
  phase: OverlayPhase;
  previousVisiblePhase: OverlayPhase;
  prompt: string;
  response: string;
  conversationId: string | null;
  conversationTitle: string;
  messages: ConversationMessage[];
  error: string | null;
  selectedHistoryId: string | null;
  requestId: string | null;
  activeAssistantMessageId: string | null;
  lastPrompt: string;
  startedAt: number | null;
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "streaming" | "complete" | "error";
  createdAt: string;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ConversationMessage[];
}

export interface HistoryItem {
  id: string;
  title: string;
  timestamp: string;
  excerpt: string;
  messageCount?: number;
}

export interface ModeGroupMetadata {
  id: "looking-for-work" | "work" | "school";
  label: string;
  order: number;
}

export interface ModeMetadata {
  id: string;
  label: string;
  shortLabel: string;
  group: ModeGroupMetadata["id"] | null;
  description: string;
  behaviorSummary: string;
  promptVersion: number;
}

export interface ModeModel {
  activeModeId: string;
  groups: ModeGroupMetadata[];
  modes: ModeMetadata[];
}

export interface Preferences {
  version: 1;
  onboardingComplete: boolean;
  launchAtLogin: boolean;
  launchOverlayAtLogin: boolean;
  reduceMotion: boolean;
  reduceTransparency: boolean;
  protectOverlayContent: boolean;
  transcriptLanguage: string;
  outputLanguage: string;
  microphoneId: string;
  captureSystemAudio: boolean;
  provider: string;
  model: string;
  customModels: Record<"nvidia" | "openai" | "anthropic", string[]>;
  mode: string;
  selectedSettingsTab: string;
  cloudEnabled: boolean;
  integrations: { notion: boolean; googleCalendar: boolean };
  keybindings: Record<string, string>;
}

export interface ProviderModel {
  id: string;
  label: string;
  description: string;
  source: "curated" | "discovered";
}

export interface ProviderConnectionError {
  code: string;
  message: string;
  provider: string;
  status: number | null;
  retryable: boolean;
}

export interface ProviderConnection {
  state: "untested" | "testing" | "connected" | "error";
  provider: string | null;
  model: string | null;
  testedAt: string | null;
  latencyMs: number | null;
  error: ProviderConnectionError | null;
}

export interface SettingsModel {
  preferences: Preferences;
  modeModel: ModeModel;
  permissions: Record<"accessibility" | "microphone" | "screen", string>;
  app: { version: string; packaged: boolean; demo: boolean };
  onboarding: boolean;
  keyConfigured: Record<string, boolean>;
  providerCatalog: { curated: ProviderModel[]; discoverySupported: boolean };
  providerConnection: ProviderConnection;
}

declare global {
  interface Window {
    clarityOverlay: {
      getState(): Promise<OverlayState>;
      dispatch(action: Record<string, unknown>): Promise<OverlayState>;
      getHistory(): Promise<HistoryItem[]>;
      getConversation(id: string): Promise<Conversation | null>;
      getModeModel(): Promise<ModeModel>;
      setMode(modeId: string): Promise<ModeModel>;
      openModePicker(layout: { desiredHeight: number; anchorRect: { x: number; y: number; width: number; height: number } }): Promise<{ placement: "above" | "below"; viewportHeight: number; surfaceOffsetY: number }>;
      closeModePicker(): Promise<boolean>;
      openSettings(tab?: string): Promise<boolean>;
      onState(listener: (state: OverlayState) => void): () => void;
      onModeModel(listener: (model: ModeModel) => void): () => void;
      onPickerClosed(listener: () => void): () => void;
      testSnapshot?(): Promise<{ overlay: OverlayState; bounds: { x: number; y: number; width: number; height: number }; settings: SettingsModel; contentProtected: boolean; resizable: boolean; pickerOpen: boolean; activeRequest: { requestId: string; modeId: string; promptVersion: number } | null; failedRequest: { modeId: string; promptVersion: number } | null }>;
      testSetBounds?(bounds: Partial<{ x: number; y: number; width: number; height: number }>): Promise<{ x: number; y: number; width: number; height: number }>;
    };
    claritySettings: {
      getModel(): Promise<SettingsModel>;
      update(patch: Partial<Preferences>): Promise<SettingsModel>;
      completeOnboarding(): Promise<boolean>;
      requestPermission(capability: "accessibility" | "microphone" | "screen"): Promise<SettingsModel["permissions"]>;
      saveProviderKey(provider: string, key: string): Promise<SettingsModel>;
      deleteProviderKey(provider: string): Promise<SettingsModel>;
      listProviderModels(): Promise<{ ok: boolean; models: ProviderModel[]; error?: ProviderConnectionError }>;
      testProviderConnection(): Promise<SettingsModel>;
      openExternal(target: string): Promise<boolean>;
      onModel(listener: (model: SettingsModel) => void): () => void;
    };
  }
}

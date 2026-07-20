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
      openSettings(): Promise<boolean>;
      onState(listener: (state: OverlayState) => void): () => void;
      testSnapshot?(): Promise<{ overlay: OverlayState; bounds: { x: number; y: number; width: number; height: number }; settings: SettingsModel; contentProtected: boolean; resizable: boolean }>;
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

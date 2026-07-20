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
  screenContext: {
    enabled: boolean;
    status: "idle" | "capturing" | "attached" | "permission-blocked" | "unsupported" | "error";
    capability: "supported" | "unsupported" | "unknown";
    attachmentId: string | null;
    capturedAt: number | null;
    displayId: string | null;
    errorCode: string | null;
    error: string | null;
  };
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
  screenContextEnabled: boolean;
  provider: string;
  model: string;
  providerModels: Record<string, string>;
  imageInputOverrides: Record<string, boolean>;
  mode: string;
  selectedSettingsTab: string;
  cloudEnabled: boolean;
  integrations: { notion: boolean; googleCalendar: boolean };
  keybindings: Record<string, string>;
}

export interface SettingsModel {
  preferences: Preferences;
  permissions: Record<"accessibility" | "microphone" | "screen", string>;
  app: { version: string; packaged: boolean; demo: boolean };
  onboarding: boolean;
  keyConfigured: Record<string, boolean>;
  imageInput: {
    capability: "supported" | "unsupported" | "unknown";
    endpointIdentity: string;
    overrideKey: string;
    explicitOverride: boolean | null;
  };
}

declare global {
  interface Window {
    clarityOverlay: {
      getState(): Promise<OverlayState>;
      dispatch(action: Record<string, unknown>): Promise<OverlayState>;
      getHistory(): Promise<HistoryItem[]>;
      getConversation(id: string): Promise<Conversation | null>;
      openSettings(): Promise<boolean>;
      openModelSettings(): Promise<boolean>;
      getScreenPreview(attachmentId: string): Promise<{ mediaType: "image/png" | "image/jpeg"; bytes: Uint8Array } | null>;
      openScreenPermissionSettings(): Promise<boolean>;
      recheckScreenPermission(): Promise<string>;
      onState(listener: (state: OverlayState) => void): () => void;
      testSnapshot?(): Promise<{ overlay: OverlayState; bounds: { x: number; y: number; width: number; height: number }; settings: SettingsModel; contentProtected: boolean; resizable: boolean; windowId: number | null }>;
      testSetBounds?(bounds: Partial<{ x: number; y: number; width: number; height: number }>): Promise<{ x: number; y: number; width: number; height: number }>;
    };
    claritySettings: {
      getModel(): Promise<SettingsModel>;
      update(patch: Partial<Preferences>): Promise<SettingsModel>;
      completeOnboarding(): Promise<boolean>;
      requestPermission(capability: "accessibility" | "microphone" | "screen"): Promise<SettingsModel["permissions"]>;
      saveProviderKey(provider: string, key: string): Promise<SettingsModel>;
      deleteProviderKey(provider: string): Promise<SettingsModel>;
      openExternal(target: string): Promise<boolean>;
      onModel(listener: (model: SettingsModel) => void): () => void;
    };
  }
}

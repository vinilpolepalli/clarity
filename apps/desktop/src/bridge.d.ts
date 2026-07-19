export type OverlayPhase =
  | "hidden"
  | "compact-idle"
  | "compact-listening"
  | "expanded-empty"
  | "expanded-response"
  | "expanded-error"
  | "expanded-history";

export interface OverlayState {
  version: 1;
  phase: OverlayPhase;
  previousVisiblePhase: OverlayPhase;
  prompt: string;
  response: string;
  error: string | null;
  selectedHistoryId: string | null;
  requestId: string | null;
  startedAt: number | null;
}

export interface HistoryItem {
  id: string;
  title: string;
  timestamp: string;
  excerpt: string;
  response: string;
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
}

declare global {
  interface Window {
    clarityOverlay: {
      getState(): Promise<OverlayState>;
      dispatch(action: Record<string, unknown>): Promise<OverlayState>;
      getHistory(): Promise<HistoryItem[]>;
      openSettings(): Promise<boolean>;
      onState(listener: (state: OverlayState) => void): () => void;
      testSnapshot?(): Promise<{ overlay: OverlayState; bounds: { x: number; y: number; width: number; height: number }; settings: SettingsModel }>;
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

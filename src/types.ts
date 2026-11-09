export type ProviderId =
  | "demo"
  | "local"
  | "openai"
  | "gemini"
  | "nvidia"
  | "opencode";
export type LiveProviderId = Exclude<ProviderId, "demo">;

export interface ProviderProfile {
  keySet: boolean;
  /** One hint per saved key, in the order they are tried. */
  keyHints: string[];
  model: string;
  baseUrl?: string;
  // Gemini-specific live/delegation models
  liveModel?: string;
  delegateModel?: string;
  thinkingModel?: string;
}

export interface ProviderProfiles {
  local: ProviderProfile;
  openai: ProviderProfile;
  gemini: ProviderProfile;
  nvidia: ProviderProfile;
  opencode: ProviderProfile;
}

export type Effort = "auto" | "low" | "medium" | "high";

/** Behaviour the backend acts on. Mirrors `settings.rs`; every field has a default there. */
export interface CoreSettings {
  temperaturePct: number;
  requestTimeoutSecs: number;
  cloudAgentEnabled: boolean;
  cloudAgentModel: string;
  cloudAgentDailyCap: number;
  cloudAgentPerMinute: number;
}

export interface ProviderConfig extends ProviderProfiles {
  mode: ProviderId;
  effort: Effort;
  settings: CoreSettings;
}

export interface ProviderProfileUpdate {
  apiKey?: string;
  clearKey?: boolean;
  /** Positions in the saved key list to delete. */
  removeKeys?: number[];
  addKeys?: string[];
  model: string;
  baseUrl?: string;
  // Gemini-specific live/delegation models
  liveModel?: string;
  delegateModel?: string;
  thinkingModel?: string;
}

export interface ProviderProfilesUpdate {
  local: ProviderProfileUpdate;
  openai: ProviderProfileUpdate;
  gemini: ProviderProfileUpdate;
  nvidia: ProviderProfileUpdate;
  opencode: ProviderProfileUpdate;
}

export interface ProviderConfigUpdate extends ProviderProfilesUpdate {
  mode: ProviderId;
}

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  CoreSettings,
  Effort,
  ProviderConfig,
  ProviderConfigUpdate,
} from "./types";

export const api = {
  /** The cloud model answered a request; the model that did. */
  onCloudUsed: (handler: (event: { model: string }) => void) =>
    listen<{ model: string }>("cloud-used", (event) => handler(event.payload)),
  /** A cloud request is waiting for Gemini's per-minute limit to free up. */
  onCloudWait: (handler: (event: { seconds: number }) => void) =>
    listen<{ seconds: number }>("cloud-wait", (event) => handler(event.payload)),
  /** The canvas agent's chat model was overloaded and the step is being tried again. */
  onCanvasRetry: (handler: (event: { attempt: number; of: number }) => void) =>
    listen<{ attempt: number; of: number }>("canvas-retry", (event) => handler(event.payload)),

  getConfig: () => invoke<ProviderConfig>("get_config"),
  setEffort: (effort: Effort) =>
    invoke<ProviderConfig>("set_effort", { effort }),
  /** Change some behaviour settings; only the keys given change. */
  setSettings: (patch: Partial<CoreSettings>) =>
    invoke<ProviderConfig>("set_settings", { patch }),
  /** Put every behaviour setting back to its default. Providers and keys stay. */
  resetSettings: () => invoke<ProviderConfig>("reset_settings"),
  /** Show the folder holding Soren's settings and data. Returns its path. */
  openDataFolder: () => invoke<string>("open_data_folder"),
  saveConfig: (update: ProviderConfigUpdate) =>
    invoke<ProviderConfig>("save_config", { update }),

  /**
   * One request to the cloud model. Each call waits in Rust for its place under the per-minute,
   * per-token and per-day caps, so callers may send many at once.
   */
  cloudComplete: (system: string, prompt: string, maxTokens: number) =>
    invoke<{ text: string; model: string; inputTokens: number }>("cloud_complete", {
      system,
      prompt,
      maxTokens,
    }).then((reply) => reply.text),

  /**
   * One short step from the chat model (Gemini Live) for the canvas agent. It gives its words, and the instruction it
   * passed to the `change_workflow` tool when the person asked for a change. The cloud model is not used here.
   */
  canvasAgent: (system: string, prompt: string) =>
    invoke<{ text: string; change: string | null; decisions?: Array<{ question: string; options: string[] }> }>("canvas_agent", { system, prompt }),
};

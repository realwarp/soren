import type { ProviderId } from "./types";

export interface ProviderMeta {
  label: string;
  shortLabel: string;
  keyPlaceholder: string;
  modelPlaceholder: string;
  endpoint: string | null;
  description: string;
  showBaseUrl?: boolean;
}

export const PROVIDER_ORDER: ProviderId[] = [
  "demo",
  "local",
  "openai",
  "gemini",
  "nvidia",
  "opencode",
];

export const PROVIDER_META: Record<ProviderId, ProviderMeta> = {
  demo: {
    label: "Demo",
    shortLabel: "Demo",
    keyPlaceholder: "",
    modelPlaceholder: "",
    endpoint: null,
    description:
      "A scripted reliability session. It exercises proposals, edits, and rejections without a model key. Useful for evaluating the interaction, not for thinking through your own idea.",
  },
  local: {
    label: "Local (llama.cpp)",
    shortLabel: "Local",
    keyPlaceholder: "",
    modelPlaceholder: "local",
    endpoint: null,
    description:
      "A model server on this machine, started by you. Run llama-server with a GGUF and point this at it — no API key is needed or stored. Thinking is turned off automatically.",
    showBaseUrl: true,
  },
  openai: {
    label: "OpenAI-compatible",
    shortLabel: "OpenAI",
    keyPlaceholder: "sk-…",
    modelPlaceholder: "gpt-4.1-mini",
    endpoint: null,
    description:
      "Any endpoint that accepts OpenAI-style chat completions. Set its base URL, model, and API key.",
    showBaseUrl: true,
  },
  gemini: {
    label: "Gemini",
    shortLabel: "Gemini",
    keyPlaceholder: "AIza…",
    modelPlaceholder: "gemini-3.8-live",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai",
    description:
      "Uses Gemini's OpenAI-compatible endpoint. Create a key in Google AI Studio at aistudio.google.com/apikey. Delegation uses gemini-3.5-flash-lite. Voice uses gemini-3.8-live.",
  },
  nvidia: {
    label: "NVIDIA",
    shortLabel: "NVIDIA",
    keyPlaceholder: "nvapi-…",
    modelPlaceholder: "nvidia/nemotron-3-super-120b-a12b",
    endpoint: "https://integrate.api.nvidia.com/v1",
    description:
      "Uses NVIDIA's NIM endpoint. Create a key at build.nvidia.com.",
  },
  opencode: {
    label: "OpenCode",
    shortLabel: "OpenCode",
    keyPlaceholder: "oc_sk_…",
    modelPlaceholder: "kimi-k2.6",
    endpoint: "https://opencode.ai/inference/openai/v1",
    description:
      "Uses an OpenCode Console service-account key from opencode.ai/console. Use a model served by the OpenAI Chat Completions endpoint.",
  },
};

import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  emptyPluginConfigSchema,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk/core";

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const XAAPI_BASE = "https://xaapi.ai";

type Family = "claude" | "openai" | "gemini";

interface FamilyConfig {
  api: "openai-responses" | "anthropic-messages";
  baseUrl: string;
  label: string;
  providerId: string;
  prefixes: string[];
  /** Optional post-filter applied after prefix matching */
  filter?: (modelId: string) => boolean;
}

const FAMILIES: Record<Family, FamilyConfig> = {
  claude: {
    api: "anthropic-messages",
    baseUrl: XAAPI_BASE,
    label: "Claude (Anthropic)",
    providerId: "xaapi-claude",
    prefixes: ["claude-"],
  },
  openai: {
    api: "openai-responses",
    baseUrl: XAAPI_BASE,
    label: "OpenAI (GPT)",
    providerId: "xaapi-openai",
    prefixes: ["gpt-"],
  },
  gemini: {
    api: "anthropic-messages",
    baseUrl: XAAPI_BASE,
    label: "Gemini (Google)",
    providerId: "xaapi-gemini",
    prefixes: ["gemini-"],
  },
};

/* ------------------------------------------------------------------ */
/*  Model metadata  [contextWindow, maxTokens, reasoning?]            */
/* ------------------------------------------------------------------ */

const MODEL_META: Record<string, [number, number, boolean?]> = {
  // OpenAI GPT-5.4
  "gpt-5.4":             [1_048_576, 128_000],
  "gpt-5.4-pro":         [1_048_576, 128_000],
  // OpenAI Codex
  "gpt-5.3-codex":       [200_000, 100_000],
  "gpt-5.2-codex":       [200_000, 100_000],
  "gpt-5.1-codex":       [200_000, 100_000],
  "gpt-5.1-codex-max":   [200_000, 100_000],
  "gpt-5.1-codex-mini":  [200_000,  32_768],
  // Claude
  "claude-opus-4-6":             [200_000, 16_384],
  "claude-sonnet-4-6":           [200_000, 16_384],
  "claude-sonnet-4-5-20250929":  [200_000, 16_384],
  "claude-haiku-4-5-20251001":   [200_000,  8_192],
  "claude-sonnet-4-20250514":    [200_000, 16_384],
  "claude-3-7-sonnet-20250219":  [200_000, 16_384],
  "claude-3-5-sonnet-20241022":  [200_000,  8_192],
  "claude-3-5-sonnet-20240620":  [200_000,  8_192],
  "claude-3-5-haiku-20241022":   [200_000,  8_192],
  "claude-3-opus-20240229":      [200_000,  4_096],
  // Gemini
  "gemini-3-pro-high":   [1_048_576, 65_536],
  "gemini-3-pro-image":  [1_048_576, 65_536],
  "gemini-3-flash":      [1_048_576, 65_536],
  "gemini-2.5-pro":      [1_048_576, 65_536],
  "gemini-2.5-flash":    [1_048_576, 65_536],
  "gemini-2.0-flash":    [1_048_576,  8_192],
};

const DEFAULT_CTX = 128_000;
const DEFAULT_MAX = 8_192;

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function classifyModel(modelId: string): Family | null {
  const id = modelId.toLowerCase();
  for (const [family, cfg] of Object.entries(FAMILIES) as [Family, FamilyConfig][]) {
    if (cfg.prefixes.some((p) => id.startsWith(p))) return family;
  }
  return null;
}

async function fetchModelsFromApi(apiKey: string): Promise<string[]> {
  const response = await fetch(`${XAAPI_BASE}/v1/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch models (HTTP ${response.status}): ${text}`);
  }
  const body = (await response.json()) as { data?: Array<{ id: string }> };
  return (body.data ?? []).map((m) => m.id).sort();
}

function ctxLabel(modelId: string): string | undefined {
  const meta = MODEL_META[modelId];
  if (!meta) return undefined;
  const ctx = meta[0] >= 1_000_000
    ? `${(meta[0] / 1_000_000).toFixed(1)}M`
    : `${(meta[0] / 1_000).toFixed(0)}k`;
  return `ctx ${ctx}, out ${(meta[1] / 1_000).toFixed(0)}k${meta[2] ? ", reasoning" : ""}`;
}

/** Read existing fallbacks from openclaw.json to append instead of replace */
function readExistingFallbacks(): string[] {
  try {
    const cfgPath = join(homedir(), ".openclaw", "openclaw.json");
    const raw = readFileSync(cfgPath, "utf-8");
    const cfg = JSON.parse(raw);
    const fb = cfg?.agents?.defaults?.model?.fallbacks;
    return Array.isArray(fb) ? fb : [];
  } catch {
    return [];
  }
}

function buildModelDef(modelId: string, api: FamilyConfig["api"]) {
  const meta = MODEL_META[modelId];
  const contextWindow = meta?.[0] ?? DEFAULT_CTX;
  const maxTokens = meta?.[1] ?? DEFAULT_MAX;
  const reasoning = meta?.[2] ?? false;

  return {
    id: modelId,
    name: modelId,
    api,
    reasoning,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
}

/* ------------------------------------------------------------------ */
/*  Plugin                                                            */
/* ------------------------------------------------------------------ */

const xaapiPlugin = {
  id: "openclaw-xaapi-auth",
  name: "XaAPI Auth",
  description: "Connect to GPT, Claude and Gemini models via xaapi.ai",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: "xaapi",
      label: "XaAPI",
      docsPath: "/providers/models",
      auth: [
        {
          id: "api-key",
          label: "API Key",
          hint: "Connect to xaapi.ai with your API key",
          kind: "custom",

          run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
            /* ---- Step 0: Security consent ---- */
            const consent = await ctx.prompter.confirm({
              message:
                "This plugin sends your API key to xaapi.ai to fetch models " +
                "and proxy LLM requests. Your key is stored ONLY in the " +
                "encrypted credential store (auth-profiles.json), never in " +
                "openclaw.json. Continue?",
              initialValue: true,
            });
            if (!consent) {
              throw new Error("Authentication cancelled by user.");
            }

            /* ---- Step 1: Select provider family ---- */
            const family = await ctx.prompter.select<Family>({
              message: "Select model provider",
              options: [
                { value: "claude", label: "Claude (Anthropic)", hint: "anthropic-messages" },
                { value: "openai", label: "OpenAI (GPT)",       hint: "openai-responses" },
                { value: "gemini", label: "Gemini (Google)",     hint: "anthropic-messages" },
              ],
            });

            const cfg = FAMILIES[family];

            /* ---- Step 2: Enter API Key ---- */
            const apiKey = (
              await ctx.prompter.text({
                message: "Enter your XaAPI API Key (from https://xaapi.ai)",
                placeholder: "sk-...",
                validate: (v: string) => {
                  const trimmed = v.trim();
                  if (trimmed.length === 0) return "API key cannot be empty";
                  if (!trimmed.startsWith("sk-")) return "API key should start with 'sk-'";
                  if (trimmed.length < 10) return "API key seems too short";
                  return undefined;
                },
              })
            ).trim();

            /* ---- Step 3: Fetch models from API ---- */
            const spin = ctx.prompter.progress(
              `Fetching ${cfg.label} models from xaapi.ai ...`,
            );

            let familyModels: string[];
            try {
              const allModels = await fetchModelsFromApi(apiKey);
              familyModels = allModels
                .filter((id) => classifyModel(id) === family)
                .filter((id) => !cfg.filter || cfg.filter(id));
              spin.stop(`Found ${familyModels.length} ${cfg.label} model(s)`);
            } catch (err: any) {
              spin.stop("Failed to fetch models");
              throw new Error(
                `Could not fetch models: ${err?.message ?? err}. Check your API key.`,
              );
            }

            if (familyModels.length === 0) {
              throw new Error(`No ${cfg.label} models available with this API key.`);
            }

            /* ---- Step 4: Multi-select models (space = toggle, enter = confirm) ---- */
            const selectedModels = await ctx.prompter.multiselect<string>({
              message: `Select ${cfg.label} models (space = toggle, enter = confirm)`,
              options: familyModels.map((id) => ({
                value: id,
                label: id,
                hint: ctxLabel(id),
              })),
              initialValues: familyModels,
            });

            if (selectedModels.length === 0) {
              throw new Error("At least one model must be selected");
            }

            /* ---- Step 5: Select primary (default) model ---- */
            const primaryModel = await ctx.prompter.select<string>({
              message: "Select PRIMARY model (used by default)",
              options: selectedModels.map((id) => ({
                value: `${cfg.providerId}/${id}`,
                label: id,
                hint: ctxLabel(id),
              })),
            });

            /* ---- Step 6: Select fallback models ---- */
            let fallbacks: string[] = [];
            if (selectedModels.length > 1) {
              const remaining = selectedModels
                .map((id) => `${cfg.providerId}/${id}`)
                .filter((ref) => ref !== primaryModel);

              fallbacks = await ctx.prompter.multiselect<string>({
                message: "Select FALLBACK models (space = toggle, enter = confirm, or enter directly to skip)",
                options: remaining.map((ref) => ({
                  value: ref,
                  label: ref.split("/")[1]!,
                  hint: ctxLabel(ref.split("/")[1]!),
                })),
              });
            }

            /* ---- Step 7: Set as default? ---- */
            const setAsDefault = await ctx.prompter.confirm({
              message: `Set ${primaryModel} as default model?`,
              initialValue: true,
            });

            /* ---- Step 8: Build result ---- */
            const providerId = cfg.providerId;

            const modelsRegistry = Object.fromEntries(
              selectedModels.map((id, i) => [
                `${providerId}/${id}`,
                i === 0 ? { alias: family } : {},
              ]),
            );

            const agentsDefaults: Record<string, any> = {
              models: modelsRegistry,
            };

            if (setAsDefault) {
              const existingFallbacks = readExistingFallbacks();
              const mergedFallbacks = [
                ...existingFallbacks.filter((fb) => fb !== primaryModel && !fallbacks.includes(fb)),
                ...fallbacks,
              ];

              agentsDefaults.model = {
                primary: primaryModel,
                ...(mergedFallbacks.length > 0 ? { fallbacks: mergedFallbacks } : {}),
              };
            }

            return {
              profiles: [
                {
                  profileId: `${providerId}:api-key`,
                  credential: {
                    type: "token",
                    provider: providerId,
                    token: apiKey,
                  },
                },
              ],
              configPatch: {
                models: {
                  providers: {
                    [providerId]: {
                      baseUrl: cfg.baseUrl,
                      // API key is NOT stored here — it lives only in the
                      // credential store (profiles/auth-profiles.json).
                      // authHeader: true tells the gateway to inject the
                      // Bearer token from the credential store at runtime.
                      api: cfg.api,
                      authHeader: true,
                      models: selectedModels.map((id) => buildModelDef(id, cfg.api)),
                    },
                  },
                },
                agents: {
                  defaults: agentsDefaults,
                },
              },
              defaultModel: primaryModel,
              notes: [
                `Provider: ${cfg.label} (${cfg.api})`,
                `Primary: ${primaryModel}`,
                ...(fallbacks.length > 0
                  ? [`Fallbacks: ${fallbacks.join(", ")}`]
                  : []),
                `${selectedModels.length} model(s) configured.`,
                "API key stored in credential store only (not in openclaw.json).",
                "Run again to add models from another provider family.",
              ],
            };
          },
        },
      ],
    });
  },
};

export default xaapiPlugin;

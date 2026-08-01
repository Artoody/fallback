const CONTEXT_WINDOW = 1_048_576;

const shared = {
  shell_type: "shell_command",
  visibility: "list",
  supported_in_api: true,
  additional_speed_tiers: [],
  service_tiers: [],
  availability_nux: null,
  upgrade: null,
  base_instructions:
    "You are Codex, a coding agent. Work carefully, use the provided tools, and keep the user informed.",
  model_messages: {
    instructions_template: null,
    instructions_variables: {
      personality_default: "",
      personality_friendly: "",
      personality_pragmatic: "",
    },
    approvals: null,
    auto_review: null,
    permissions: null,
  },
  include_skills_usage_instructions: false,
  default_reasoning_summary: "auto",
  support_verbosity: false,
  default_verbosity: "medium",
  apply_patch_tool_type: "freeform",
  web_search_tool_type: "text",
  truncation_policy: { mode: "tokens", limit: 10_000 },
  supports_parallel_tool_calls: true,
  supports_image_detail_original: false,
  context_window: CONTEXT_WINDOW,
  max_context_window: CONTEXT_WINDOW,
  effective_context_window_percent: 95,
  experimental_supported_tools: [],
  input_modalities: ["text", "image"],
  supports_search_tool: true,
  use_responses_lite: false,
  tool_mode: "code_mode_only",
  multi_agent_version: "v1",
};

function reasoningLevel(effort) {
  const descriptions = {
    minimal: "Fastest response with minimal reasoning.",
    low: "Faster response with light reasoning.",
    medium: "Balanced reasoning for everyday coding work.",
    high: "Deeper reasoning for difficult coding work.",
  };
  return { effort, description: descriptions[effort] };
}

export const CODEX_MODELS = Object.freeze([
  Object.freeze({
    ...shared,
    slug: "gemini-3.6-flash",
    display_name: "Gemini 3.6 Flash",
    description: "Stable Gemini coding model with a 1M-token context window.",
    default_reasoning_level: "medium",
    supported_reasoning_levels: ["minimal", "low", "medium", "high"].map(reasoningLevel),
    priority: 10,
    comp_hash: "gemini-3.6-flash-codex-v1",
  }),
  Object.freeze({
    ...shared,
    slug: "gemini-3.1-pro-preview-customtools",
    display_name: "Gemini 3.1 Pro Preview (Custom Tools)",
    description:
      "Preview Gemini model optimized for complex coding and custom-tool workflows; quality and availability may fluctuate.",
    default_reasoning_level: "high",
    supported_reasoning_levels: ["low", "medium", "high"].map(reasoningLevel),
    priority: 20,
    comp_hash: "gemini-3.1-pro-preview-customtools-codex-v1",
  }),
]);

const bySlug = new Map(CODEX_MODELS.map((model) => [model.slug, model]));

export function getCodexModel(slug) {
  return bySlug.get(String(slug || "")) || null;
}

export function getCodexModelCatalog() {
  return { models: CODEX_MODELS };
}

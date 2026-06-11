export const piAuthProviders = [
  {key: "anthropic", label: "Anthropic"},
  {key: "ant-ling", label: "Ant Ling"},
  {key: "azure-openai-responses", label: "Azure OpenAI Responses"},
  {key: "openai", label: "OpenAI"},
  {key: "openai-codex", label: "OpenAI ChatGPT Plus/Pro (Codex)"},
  {key: "deepseek", label: "DeepSeek"},
  {key: "nvidia", label: "NVIDIA NIM"},
  {key: "google", label: "Google Gemini"},
  {key: "mistral", label: "Mistral"},
  {key: "groq", label: "Groq"},
  {key: "cerebras", label: "Cerebras"},
  {key: "cloudflare-ai-gateway", label: "Cloudflare AI Gateway"},
  {key: "cloudflare-workers-ai", label: "Cloudflare Workers AI"},
  {key: "xai", label: "xAI"},
  {key: "openrouter", label: "OpenRouter"},
  {key: "vercel-ai-gateway", label: "Vercel AI Gateway"},
  {key: "zai", label: "ZAI"},
  {key: "zai-coding-cn", label: "ZAI Coding Plan (China)"},
  {key: "opencode", label: "OpenCode Zen"},
  {key: "opencode-go", label: "OpenCode Go"},
  {key: "huggingface", label: "Hugging Face"},
  {key: "fireworks", label: "Fireworks"},
  {key: "together", label: "Together AI"},
  {key: "kimi-coding", label: "Kimi For Coding"},
  {key: "minimax", label: "MiniMax"},
  {key: "minimax-cn", label: "MiniMax (China)"},
  {key: "xiaomi", label: "Xiaomi MiMo"},
  {key: "xiaomi-token-plan-cn", label: "Xiaomi MiMo Token Plan (China)"},
  {key: "xiaomi-token-plan-ams", label: "Xiaomi MiMo Token Plan (Amsterdam)"},
  {key: "xiaomi-token-plan-sgp", label: "Xiaomi MiMo Token Plan (Singapore)"},
];

export function piAuthProviderLabel(key) {
  const provider = piAuthProviders.find((item) => item.key === key);
  return provider ? provider.label : key;
}

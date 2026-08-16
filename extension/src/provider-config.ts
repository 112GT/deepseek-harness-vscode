/**
 * Non-secret model-provider state used by the VS Code UI and Host sidecar.
 * API keys intentionally never appear in these objects or in settings.yaml.
 */
export const DEEPSEEK_API_KEY_SECRET = 'deepseekHarness.apiKey'

export type ProviderKind = 'openai' | 'anthropic' | 'google' | 'openai-compatible'

export interface ModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface ModelOption extends ModelSelection {
  readonly label: string
  readonly description: string
  readonly tone: 'pro' | 'flash' | 'openai' | 'anthropic' | 'google' | 'compatible'
}

/** Configuration metadata that may safely be persisted in VS Code globalState. */
export interface ManagedProvider {
  readonly route: string
  readonly kind: ProviderKind
  readonly displayName: string
  readonly model: string
  readonly baseURL?: string
  readonly apiKeyEnv: string
}

export const DEFAULT_MODEL_SELECTION: ModelSelection = {
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
}

export const DEEPSEEK_MODEL_OPTIONS: readonly ModelOption[] = [
  {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    description: 'Complete reasoning',
    tone: 'pro',
  },
  {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    description: 'Fast response',
    tone: 'flash',
  },
]

export function modelOption(provider: ManagedProvider): ModelOption {
  const prefix = provider.kind === 'openai'
    ? 'OpenAI'
    : provider.kind === 'anthropic'
      ? 'Anthropic Claude'
      : provider.kind === 'google'
        ? 'Google Gemini'
        : provider.displayName
  return {
    provider: provider.route,
    model: provider.model,
    label: `${prefix} · ${provider.model}`,
    description: provider.baseURL === undefined ? 'Configured API provider' : provider.baseURL,
    tone: provider.kind === 'openai-compatible' ? 'compatible' : provider.kind,
  }
}

export function providerSecretKey(provider: ManagedProvider): string {
  return `deepseekHarness.providerKey.${provider.route}`
}

/** Harness llm-pi-ai profile. It references an environment variable, never a key. */
export function harnessProviderProfile(provider: ManagedProvider): Record<string, unknown> {
  const profile: Record<string, unknown> = {
    displayName: provider.displayName,
    apiKeyEnv: provider.apiKeyEnv,
    models: [{ id: provider.model, name: provider.model }],
  }
  if (provider.kind === 'openai-compatible') {
    profile.api = 'openai-completions'
    profile.baseURL = provider.baseURL
  } else if (provider.baseURL !== undefined && provider.baseURL.length > 0) {
    profile.baseURL = provider.baseURL
  }
  return profile
}

export function isModelSelection(value: unknown): value is ModelSelection {
  if (value === null || typeof value !== 'object') return false
  const selection = value as Record<string, unknown>
  return typeof selection.provider === 'string' && selection.provider.length > 0
    && typeof selection.model === 'string' && selection.model.length > 0
}

export function selectionKey(selection: ModelSelection): string {
  return `${selection.provider}\u0000${selection.model}`
}

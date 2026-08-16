import * as vscode from 'vscode'
import { parse, stringify } from 'yaml'
import {
  DEEPSEEK_API_KEY_SECRET,
  DEEPSEEK_MODEL_OPTIONS,
  DEFAULT_MODEL_SELECTION,
  harnessProviderProfile,
  modelOption,
  providerSecretKey,
  selectionKey,
  type ManagedProvider,
  type ModelOption,
  type ModelSelection,
  type ProviderKind,
} from './provider-config'

const PROVIDERS_STATE_KEY = 'deepseekHarness.managedProviders'
const KNOWN_ROUTES: Readonly<Record<Exclude<ProviderKind, 'openai-compatible'>, string>> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
}

/**
 * Manages keys in SecretStorage and the matching non-secret llm-pi-ai
 * profiles in the sidecar home. This keeps third-party credentials out of
 * workspace files, global settings, and package artifacts.
 */
export class ProviderManager {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {}

  selected(): ModelSelection {
    const configuration = vscode.workspace.getConfiguration('deepseekHarness')
    const provider = configuration.get<string>('modelProvider', DEFAULT_MODEL_SELECTION.provider).trim()
    const model = configuration.get<string>('model', DEFAULT_MODEL_SELECTION.model).trim()
    const reasoningEffort = configuration.get<string>('reasoningEffort', 'auto').trim()
    return {
      provider: provider.length === 0 ? DEFAULT_MODEL_SELECTION.provider : provider,
      model: model.length === 0 ? DEFAULT_MODEL_SELECTION.model : model,
      ...(reasoningEffort.length === 0 || reasoningEffort === 'auto' ? {} : { reasoningEffort }),
    }
  }

  modelOptions(): readonly ModelOption[] {
    return [...DEEPSEEK_MODEL_OPTIONS, ...this.providers().map(modelOption)]
  }

  async isSelectedCredentialConfigured(): Promise<boolean> {
    const selection = this.selected()
    if (selection.provider === 'deepseek-official') {
      return (await this.context.secrets.get(DEEPSEEK_API_KEY_SECRET)) !== undefined
    }
    const provider = this.providers().find(item => item.route === selection.provider)
    return provider !== undefined && (await this.context.secrets.get(providerSecretKey(provider))) !== undefined
  }

  async environment(): Promise<NodeJS.ProcessEnv> {
    const environment: NodeJS.ProcessEnv = {}
    const deepSeekKey = await this.context.secrets.get(DEEPSEEK_API_KEY_SECRET)
    if (deepSeekKey !== undefined) environment.DEEPSEEK_API_KEY = deepSeekKey
    for (const provider of this.providers()) {
      const key = await this.context.secrets.get(providerSecretKey(provider))
      if (key !== undefined) environment[provider.apiKeyEnv] = key
    }
    return environment
  }

  async configureDeepSeek(): Promise<boolean> {
    const value = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      password: true,
      title: 'DeepSeek API key',
      prompt: 'Enter the DeepSeek API key for this VS Code extension.',
      validateInput: candidate => candidate.trim().length >= 12 ? undefined : 'Enter a valid API key.',
    })
    if (value === undefined) return false
    await this.context.secrets.store(DEEPSEEK_API_KEY_SECRET, value.trim())
    this.output.appendLine('DeepSeek API key stored in VS Code SecretStorage.')
    return true
  }

  async chooseAndConfigure(): Promise<ModelSelection | undefined> {
    const choices: Array<vscode.QuickPickItem & { readonly action: 'deepseek' | 'add' | 'edit' | 'remove'; readonly providerKind?: ProviderKind; readonly managedProvider?: ManagedProvider }> = [
      { label: 'DeepSeek', description: 'Configure DeepSeek API key', action: 'deepseek' },
      { label: 'OpenAI', description: 'GPT models through the official OpenAI API', action: 'add', providerKind: 'openai' },
      { label: 'Anthropic Claude', description: 'Claude models through the Anthropic API', action: 'add', providerKind: 'anthropic' },
      { label: 'Google Gemini', description: 'Gemini models through the Google API', action: 'add', providerKind: 'google' },
      { label: 'OpenAI-compatible API', description: 'Qwen, Kimi, GLM, MiniMax, OpenRouter, or a self-hosted endpoint', action: 'add', providerKind: 'openai-compatible' },
    ]
    choices.push(...this.providers().map(provider => ({
      label: `Update: ${provider.displayName}`,
      description: provider.model,
      detail: provider.route,
      action: 'edit' as const,
      providerKind: provider.kind,
      managedProvider: provider,
    })))
    if (this.providers().length > 0) choices.push({ label: 'Remove a configured provider', description: 'Deletes its local profile and stored API key', action: 'remove' })
    const picked = await vscode.window.showQuickPick(choices, {
      title: 'Model providers',
      placeHolder: 'Select a provider to configure',
      ignoreFocusOut: true,
    })
    if (picked === undefined) return undefined
    if (picked.action === 'deepseek') {
      if (!await this.configureDeepSeek()) return undefined
      return this.selected().provider === 'deepseek-official' ? this.selected() : DEFAULT_MODEL_SELECTION
    }
    if (picked.action === 'remove') return this.removeProvider()
    return this.configureProvider(picked.providerKind, picked.managedProvider)
  }

  async setSelected(selection: ModelSelection): Promise<void> {
    const available = new Set(this.modelOptions().map(selectionKey))
    if (!available.has(selectionKey(selection))) throw new Error('This model provider is no longer configured.')
    const configuration = vscode.workspace.getConfiguration('deepseekHarness')
    await configuration.update('modelProvider', selection.provider, vscode.ConfigurationTarget.Global)
    await configuration.update('model', selection.model, vscode.ConfigurationTarget.Global)
    if (selection.provider !== 'deepseek-official' || selection.model !== 'deepseek-v4-pro') {
      await configuration.update('reasoningEffort', 'auto', vscode.ConfigurationTarget.Global)
    }
    this.output.appendLine(`Model route changed to ${selection.provider}/${selection.model}.`)
  }

  async setReasoningEffort(effort: string): Promise<void> {
    const normalized = effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'max' ? effort : 'auto'
    await vscode.workspace.getConfiguration('deepseekHarness').update('reasoningEffort', normalized, vscode.ConfigurationTarget.Global)
    this.output.appendLine(`Model reasoning effort changed to ${normalized}.`)
  }

  configuredSummary(): string {
    const providers = this.providers()
    return providers.length === 0 ? 'DeepSeek only' : `${providers.length} third-party configured`
  }

  private async configureProvider(kind: ProviderKind | undefined, target?: ManagedProvider): Promise<ModelSelection | undefined> {
    if (kind === undefined) return undefined
    const existing = target ?? this.providers().find(provider => provider.kind === kind && kind !== 'openai-compatible')
    const defaults = defaultsFor(kind)
    const displayName = kind === 'openai-compatible'
      ? await this.input('Provider name', 'For example: OpenRouter, Qwen, or Local Gateway', undefined, 'A provider name is required.')
      : defaults.displayName
    if (displayName === undefined) return undefined
    const model = await this.input('Model ID', `Model identifier for ${displayName}`, existing?.model ?? defaults.model, 'A model ID is required.')
    if (model === undefined) return undefined
    const baseURL = kind === 'openai-compatible'
      ? await this.input('API base URL', 'For example: https://api.example.com/v1', existing?.baseURL, 'An OpenAI-compatible API base URL is required.', value => /^https?:\/\//.test(value) ? undefined : 'Enter an http(s) URL.')
      : await this.optionalInput('API base URL override', 'Leave empty to use the provider default endpoint.', existing?.baseURL)
    if (baseURL === undefined) return undefined
    const route = existing?.route ?? (kind === 'openai-compatible' ? compatibleRoute(displayName, this.providers()) : KNOWN_ROUTES[kind])
    const apiKeyEnv = existing?.apiKeyEnv ?? environmentNameFor(kind, route)
    const apiKey = await vscode.window.showInputBox({
      title: `${displayName} API key`,
      prompt: existing === undefined ? 'Enter the API key. It is stored only in VS Code SecretStorage.' : 'Enter a replacement API key, or leave empty to keep the saved key.',
      password: true,
      ignoreFocusOut: true,
      validateInput: value => {
        const normalized = value.trim()
        if (normalized.length === 0) return existing === undefined ? 'An API key is required for a new provider.' : undefined
        return normalized.length >= 8 ? undefined : 'Enter a valid API key.'
      },
    })
    if (apiKey === undefined) return undefined
    const provider: ManagedProvider = { route, kind, displayName, model, ...(baseURL.length === 0 ? {} : { baseURL }), apiKeyEnv }
    await this.warnBeforeReplacingUnmanagedProfile(provider)
    const providers = [...this.providers().filter(item => item.route !== route), provider]
    await this.saveProviders(providers)
    if (apiKey.trim().length > 0) await this.context.secrets.store(providerSecretKey(provider), apiKey.trim())
    this.output.appendLine(`Configured ${displayName} (${route}); its API key is stored in VS Code SecretStorage.`)
    return { provider: route, model }
  }

  private async removeProvider(): Promise<ModelSelection | undefined> {
    const provider = await vscode.window.showQuickPick(this.providers().map(item => ({
      label: item.displayName,
      description: item.model,
      detail: item.route,
      provider: item,
    })), { title: 'Remove model provider', placeHolder: 'Select the provider to remove', ignoreFocusOut: true })
    if (provider === undefined) return undefined
    const answer = await vscode.window.showWarningMessage(`Remove ${provider.provider.displayName} and its stored API key?`, { modal: true }, 'Remove')
    if (answer !== 'Remove') return undefined
    await this.context.secrets.delete(providerSecretKey(provider.provider))
    await this.saveProviders(this.providers().filter(item => item.route !== provider.provider.route))
    const selected = this.selected()
    if (selected.provider === provider.provider.route) {
      await this.setSelected(DEFAULT_MODEL_SELECTION)
      return DEFAULT_MODEL_SELECTION
    }
    return selected
  }

  private providers(): readonly ManagedProvider[] {
    const value = this.context.globalState.get<unknown>(PROVIDERS_STATE_KEY, [])
    return Array.isArray(value) ? value.filter(isManagedProvider) : []
  }

  private async saveProviders(providers: readonly ManagedProvider[]): Promise<void> {
    await this.writeHarnessProfiles(this.providers(), providers)
    await this.context.globalState.update(PROVIDERS_STATE_KEY, [...providers])
  }

  private async writeHarnessProfiles(previous: readonly ManagedProvider[], next: readonly ManagedProvider[]): Promise<void> {
    const home = vscode.Uri.file(this.context.globalStorageUri.fsPath)
    const directory = vscode.Uri.joinPath(home, 'host-home')
    const file = vscode.Uri.joinPath(directory, 'settings.yaml')
    await vscode.workspace.fs.createDirectory(directory)
    let root: Record<string, unknown> = {}
    try {
      const source = new TextDecoder().decode(await vscode.workspace.fs.readFile(file))
      const parsed = parse(source)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) root = parsed as Record<string, unknown>
    } catch (error) {
      if (!(error instanceof vscode.FileSystemError)) throw new Error(`Unable to read Harness settings.yaml: ${errorMessage(error)}`)
    }
    const section = objectValue(root['llm-pi-ai'])
    const profiles = objectValue(section.providers)
    for (const provider of previous) delete profiles[provider.route]
    for (const provider of next) profiles[provider.route] = harnessProviderProfile(provider)
    section.providers = profiles
    root['llm-pi-ai'] = section
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(stringify(root)))
  }

  private async warnBeforeReplacingUnmanagedProfile(provider: ManagedProvider): Promise<void> {
    if (this.providers().some(item => item.route === provider.route)) return
    const file = vscode.Uri.joinPath(vscode.Uri.file(this.context.globalStorageUri.fsPath), 'host-home', 'settings.yaml')
    try {
      const root = parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(file)))
      const section = root !== null && typeof root === 'object' && !Array.isArray(root) ? objectValue((root as Record<string, unknown>)['llm-pi-ai']) : {}
      if (!(provider.route in objectValue(section.providers))) return
    } catch (error) {
      if (error instanceof vscode.FileSystemError) return
      throw new Error(`Unable to read Harness settings.yaml: ${errorMessage(error)}`)
    }
    const answer = await vscode.window.showWarningMessage(
      `Harness settings already contain a ${provider.route} provider profile. Replace it with this VS Code-managed profile?`,
      { modal: true },
      'Replace profile',
    )
    if (answer !== 'Replace profile') throw new Error('Provider configuration was cancelled to preserve the existing Harness profile.')
  }

  private input(title: string, prompt: string, value: string | undefined, emptyMessage: string, validate?: (value: string) => string | undefined): Promise<string | undefined> {
    return Promise.resolve(vscode.window.showInputBox({ title, prompt, value, ignoreFocusOut: true, validateInput: candidate => {
      const normalized = candidate.trim()
      return normalized.length === 0 ? emptyMessage : validate?.(normalized)
    } }).then(result => result?.trim()))
  }

  private optionalInput(title: string, prompt: string, value: string | undefined): Promise<string | undefined> {
    return Promise.resolve(vscode.window.showInputBox({ title, prompt, value: value ?? '', ignoreFocusOut: true, validateInput: candidate => {
      const normalized = candidate.trim()
      return normalized.length === 0 || /^https?:\/\//.test(normalized) ? undefined : 'Enter an http(s) URL or leave blank.'
    } }).then(result => result?.trim()))
  }
}

function defaultsFor(kind: ProviderKind): { readonly displayName: string; readonly model: string } {
  switch (kind) {
    case 'openai': return { displayName: 'OpenAI', model: 'gpt-4.1' }
    case 'anthropic': return { displayName: 'Anthropic Claude', model: 'claude-sonnet-4-5' }
    case 'google': return { displayName: 'Google Gemini', model: 'gemini-2.5-pro' }
    case 'openai-compatible': return { displayName: 'OpenAI-compatible API', model: '' }
  }
}

function environmentNameFor(kind: ProviderKind, route: string): string {
  if (kind === 'openai') return 'DSH_VSCODE_OPENAI_API_KEY'
  if (kind === 'anthropic') return 'DSH_VSCODE_ANTHROPIC_API_KEY'
  if (kind === 'google') return 'DSH_VSCODE_GOOGLE_API_KEY'
  return `DSH_VSCODE_${route.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_API_KEY`
}

function compatibleRoute(displayName: string, existing: readonly ManagedProvider[]): string {
  const slug = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'provider'
  const base = `vscode-${slug}`
  let route = base
  let suffix = 2
  const occupied = new Set(existing.map(provider => provider.route))
  while (occupied.has(route)) route = `${base}-${suffix++}`
  return route
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function isManagedProvider(value: unknown): value is ManagedProvider {
  if (value === null || typeof value !== 'object') return false
  const provider = value as Record<string, unknown>
  return typeof provider.route === 'string' && typeof provider.displayName === 'string'
    && typeof provider.model === 'string' && typeof provider.apiKeyEnv === 'string'
    && (provider.kind === 'openai' || provider.kind === 'anthropic' || provider.kind === 'google' || provider.kind === 'openai-compatible')
    && (provider.baseURL === undefined || typeof provider.baseURL === 'string')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

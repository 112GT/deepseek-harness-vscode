import * as vscode from 'vscode'
import * as path from 'node:path'
import { ChatViewProvider } from './chat-view'
import { HostRunner } from './runner/host-runner'
import { HarnessSourceLocator } from './runner/source-locator'
import { RuntimeViewProvider } from './runtime-view'
import { WorkspaceChangeDecorationProvider, WorkspaceChangeTracker } from './workspace-changes'
import { DeepSeekInlineCompletionProvider } from './inline-completion'
import { PrewriteReviewService } from './prewrite-review'
import { CapabilityViewProvider } from './capability-view'
import { CapabilitiesHotReloader } from './capabilities-hot-reload'
import type { HarnessPreset, HarnessSkill } from './runner/runner'
import { ProviderManager } from './provider-manager'
import { DEEPSEEK_API_KEY_SECRET, type ModelSelection } from './provider-config'
import { TerminalContextRecorder } from './terminal-context'

/** Activates the independent DeepSeek Harness VS Code sidebar. */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('DeepSeek Harness')
  const locator = new HarnessSourceLocator(context.extensionUri)
  const providers = new ProviderManager(context, output)
  const configureApiKey = (): Promise<boolean> => providers.configureDeepSeek()
  await importBootstrapApiKey(context, output)
  const review = new PrewriteReviewService()
  const terminalContext = new TerminalContextRecorder()
  const runner = new HostRunner(context, locator, () => providers.environment(), () => providers.selected(), () => providers.isSelectedCredentialConfigured(), review)
  const runtimeView = new RuntimeViewProvider(locator, context.secrets, runner, providers)
  const capabilityView = new CapabilityViewProvider(() => runner.inspectCapabilities())
  const capabilityHotReload = new CapabilitiesHotReloader(context, locator, runner, capabilityView, output)
  const changeTracker = new WorkspaceChangeTracker()
  const changeDecorations = new WorkspaceChangeDecorationProvider(changeTracker)
  const setModel = async (model: ModelSelection): Promise<void> => {
    if (runner.getStatus().state === 'running') throw new Error('Wait for the current Harness turn to finish before changing its model.')
    await providers.setSelected(model)
  }
  const setReasoningEffort = async (effort: string): Promise<void> => {
    if (runner.getStatus().state === 'running') throw new Error('Wait for the current Harness turn to finish before changing its reasoning level.')
    await providers.setReasoningEffort(effort)
  }
  const configureProviders = async (): Promise<void> => {
    if (runner.getStatus().state === 'running') throw new Error('Stop the current Harness turn before changing model providers.')
    if (runner.getStatus().state !== 'stopped') await runner.stop()
    const selected = await providers.chooseAndConfigure()
    if (selected !== undefined) await providers.setSelected(selected)
    refresh()
  }
  const permissionMode = (): 'read-only' | 'workspace-write' | 'danger-full-access' => {
    const configured = vscode.workspace.getConfiguration('deepseekHarness').get<string>('permissionMode', 'workspace-write')
    return configured === 'read-only' || configured === 'danger-full-access' ? configured : 'workspace-write'
  }
  const setPermissionMode = async (mode: 'read-only' | 'workspace-write' | 'danger-full-access'): Promise<void> => {
    if (runner.getStatus().state === 'running') throw new Error('Stop the current Harness turn before changing access mode.')
    if (mode === 'danger-full-access') {
      const confirmed = await vscode.window.showWarningMessage(
        'All access allows Harness tools to access files outside the workspace without per-tool approval.',
        { modal: true },
        'Use all access',
      )
      if (confirmed !== 'Use all access') return
    }
    if (runner.getStatus().state !== 'stopped') await runner.stop()
    await vscode.workspace.getConfiguration('deepseekHarness').update('permissionMode', mode, vscode.ConfigurationTarget.Global)
    output.appendLine(`Harness access mode changed to ${mode}. The next request starts a new local Host with that mode.`)
  }
  const versionSnapshots = (): boolean => vscode.workspace.getConfiguration('deepseekHarness').get<boolean>('versionSnapshots', false)
  const toggleVersionSnapshots = async (): Promise<boolean> => {
    const enabled = !versionSnapshots()
    await vscode.workspace.getConfiguration('deepseekHarness').update('versionSnapshots', enabled, vscode.ConfigurationTarget.Global)
    output.appendLine(`Workspace version snapshots ${enabled ? 'enabled' : 'disabled'}.`)
    return enabled
  }
  const chatView = new ChatViewProvider(
    runner,
    configureApiKey,
    () => providers.isSelectedCredentialConfigured(),
    () => providers.selected(),
    () => providers.modelOptions(),
    setModel,
    () => providers.selected().reasoningEffort ?? 'auto',
    setReasoningEffort,
    configureProviders,
    permissionMode,
    setPermissionMode,
    versionSnapshots,
    toggleVersionSnapshots,
    changeTracker,
    terminalContext,
  )
  const treeView = vscode.window.createTreeView('deepseekHarness.runtime', { treeDataProvider: runtimeView })
  const capabilitiesTreeView = vscode.window.createTreeView('deepseekHarness.capabilities', { treeDataProvider: capabilityView })
  const refresh = (): void => {
    runtimeView.refresh()
  }

  context.subscriptions.push(output, locator, runner, review, runtimeView, capabilityView, capabilityHotReload, changeTracker, changeDecorations, terminalContext, chatView, treeView, capabilitiesTreeView)
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(changeDecorations))
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(review.scheme, review))
  context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider(
    { scheme: 'file' },
    new DeepSeekInlineCompletionProvider(async () => context.secrets.get(DEEPSEEK_API_KEY_SECRET)),
  ))
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('deepseekHarness.chat', chatView, {
    // Recreate the DOM when the view is shown again; retained Webviews can
    // keep controls visible after their old extension-host message port dies.
    webviewOptions: { retainContextWhenHidden: false },
  }))
  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.refreshRuntime', refresh))
  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.refreshCapabilities', async () => {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Refreshing DeepSeek Harness capabilities' }, () => capabilityHotReload.refreshNow())
  }))
  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.toggleCapabilitiesAutoRefresh', async () => {
    await capabilityHotReload.toggle()
  }))
  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.openHarnessSettings', async () => {
    try {
      await runner.openHarnessSettings()
    } catch (error) {
      void vscode.window.showErrorMessage(`Unable to open Harness settings: ${errorMessage(error)}`)
    }
  }))
  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.openExtensionSettings', async () => {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'DeepSeek Harness')
  }))
  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.invokeSkill', async (skill: unknown) => {
    if (!isHarnessSkill(skill)) return
    try {
      await chatView.invokeSkill(skill.name, skill.description)
    } catch (error) {
      void vscode.window.showErrorMessage(`Unable to start skill ${skill.name}: ${errorMessage(error)}`)
    }
  }))
  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.selectAgentPreset', async (preset: unknown) => {
    if (!isHarnessPreset(preset) || preset.broken !== undefined) return
    try {
      await chatView.startWithPreset(preset.id, preset.name)
      await capabilityHotReload.refreshNow()
    } catch (error) {
      void vscode.window.showErrorMessage(`Unable to select agent preset: ${errorMessage(error)}`)
    }
  }))
  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.manageAgentPresets', async () => {
    try {
      await manageAgentPresets(runner, chatView)
      await capabilityHotReload.refreshNow()
    } catch (error) {
      void vscode.window.showErrorMessage(`Unable to manage agent presets: ${errorMessage(error)}`)
    }
  }))
  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.openPluginCenter', async () => {
    try {
      await openPluginCenter(runner, chatView)
      await capabilityHotReload.refreshNow()
    } catch (error) {
      void vscode.window.showErrorMessage(`Unable to open the Harness Plugin Center: ${errorMessage(error)}`)
    }
  }))
  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.configureApiKey', async () => {
    if (await configureApiKey()) refresh()
  }))
  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.manageModelProviders', async () => {
    try {
      await configureProviders()
    } catch (error) {
      void vscode.window.showErrorMessage(`Unable to configure model providers: ${errorMessage(error)}`)
    }
  }))
  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.openChat', () => chatView.focus()))
  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.newSession', () => chatView.newSession()))
  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.stopRunner', async () => runner.stop()))
  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.startRunner', async () => {
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Starting local DeepSeek Harness Runner', cancellable: false }, () => runner.startLocalHost())
      refresh()
    } catch (error) {
      void vscode.window.showErrorMessage(`Unable to start local Harness Runner: ${errorMessage(error)}`)
    }
  }))
  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.selectHarnessFolder', async () => {
    const selection = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Use this Harness folder',
      title: 'Select the DeepSeek Harness source folder',
    })
    const folder = selection?.[0]
    if (folder === undefined) return
    await vscode.workspace.getConfiguration('deepseekHarness').update('harnessPath', folder.fsPath, vscode.ConfigurationTarget.Global)
    refresh()
  }))
  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.prepareRunner', async () => {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Preparing DeepSeek Harness runtime', cancellable: false }, () => runner.prepare())
    refresh()
  }))
  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.verifyConnection', async () => {
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Verifying configured model connection', cancellable: false }, () => runner.verifyConnection())
      void vscode.window.showInformationMessage('Model connection verified. Your API key remains in VS Code SecretStorage.')
    } catch (error) {
      void vscode.window.showErrorMessage(`Model connection check failed: ${errorMessage(error)}`)
    }
  }))
  context.subscriptions.push(runner.onDidChangeStatus(status => {
    output.appendLine(`Runner: ${status.state} — ${status.detail}`)
    refresh()
  }))

  await capabilityHotReload.start()
  const source = await locator.inspect()
  output.appendLine(`Harness source: ${source.state}${source.version === undefined ? '' : ` (${source.version})`}`)
}

/** VS Code disposes registered resources during deactivation. */
export function deactivate(): void {}

/** Imports an explicitly configured local credential only when SecretStorage is empty. */
async function importBootstrapApiKey(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  if (await context.secrets.get(DEEPSEEK_API_KEY_SECRET) !== undefined) return
  const configured = vscode.workspace.getConfiguration('deepseekHarness').get<string>('bootstrapCredentialsFile', '').trim()
  if (configured.length === 0) return
  const file = path.isAbsolute(configured)
    ? vscode.Uri.file(configured)
    : vscode.Uri.file(path.resolve(context.extensionUri.fsPath, configured))
  try {
    const source = new TextDecoder().decode(await vscode.workspace.fs.readFile(file))
    const value = yamlCredential(source, 'DEEPSEEK_API_KEY')
    if (value === undefined || value.length < 12) {
      output.appendLine('Configured bootstrap credentials file does not contain a valid DeepSeek API key.')
      return
    }
    await context.secrets.store(DEEPSEEK_API_KEY_SECRET, value)
    output.appendLine('DeepSeek API key migrated to VS Code SecretStorage.')
  } catch (error) {
    output.appendLine(`Unable to import the configured bootstrap credentials file: ${errorMessage(error)}`)
  }
}

function yamlCredential(source: string, name: string): string | undefined {
  const pattern = new RegExp(`^\\s*${name}\\s*:\\s*(.*?)\\s*$`, 'm')
  const value = source.match(pattern)?.[1]?.trim()
  if (value === undefined || value.length === 0) return undefined
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).trim()
  }
  return value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isHarnessSkill(value: unknown): value is HarnessSkill {
  if (value === null || typeof value !== 'object') return false
  const skill = value as Record<string, unknown>
  return typeof skill.name === 'string' && typeof skill.modelInvocable === 'boolean'
}

function isHarnessPreset(value: unknown): value is HarnessPreset {
  if (value === null || typeof value !== 'object') return false
  const preset = value as Record<string, unknown>
  return typeof preset.id === 'string'
    && typeof preset.name === 'string'
    && (preset.trust === 'system' || preset.trust === 'user')
    && typeof preset.isDefault === 'boolean'
}

async function manageAgentPresets(runner: HostRunner, chat: ChatViewProvider): Promise<void> {
  const presets = await runner.listPresets()
  const action = await vscode.window.showQuickPick([
    { label: 'Start a new session with a preset', value: 'select' as const, description: 'The selected preset applies before the first prompt.' },
    { label: 'Copy a preset for customization', value: 'copy' as const, description: 'Creates a user-owned preset that can be edited later.' },
    { label: 'Edit, enable, or disable user preset plugins', value: 'open' as const, description: 'Open agent.cordis.yml and change each plugin row\'s disabled value.' },
    { label: 'Delete a user preset', value: 'delete' as const, description: 'Permanently removes a user-owned preset; shipped presets are protected.' },
  ], { title: 'Harness agent presets' })
  if (action === undefined) return
  const candidates = action.value === 'open' || action.value === 'delete'
    ? presets.filter(preset => preset.trust === 'user' && preset.broken === undefined)
    : presets.filter(preset => preset.broken === undefined)
  if (candidates.length === 0) throw new Error(action.value === 'open' || action.value === 'delete' ? 'No user-owned editable presets are available yet. Copy a preset first.' : 'No usable agent presets are available.')
  const picked = await vscode.window.showQuickPick(candidates.map(preset => ({
    label: preset.name,
    description: `${preset.trust}${preset.isDefault ? ' · default' : ''}`,
    detail: preset.description,
    preset,
  })), { title: action.value === 'select' ? 'Select preset for a new session' : 'Copy a preset' })
  if (picked === undefined) return
  if (action.value === 'select') {
    await chat.startWithPreset(picked.preset.id, picked.preset.name)
    return
  }
  if (action.value === 'open') {
    await runner.openPresetDocument(picked.preset.id)
    void vscode.window.showInformationMessage('In agent.cordis.yml, set disabled: false to enable a plugin or disabled: true to disable it. Start a new session after saving.')
    return
  }
  if (action.value === 'delete') {
    const confirmed = await vscode.window.showWarningMessage(
      `Delete the user preset “${picked.preset.name}”? This cannot be undone.`,
      { modal: true },
      'Delete preset',
    )
    if (confirmed === 'Delete preset') await runner.removePreset(picked.preset.id)
    return
  }
  const id = await vscode.window.showInputBox({
    title: 'New agent preset id',
    prompt: 'Use lowercase letters, numbers and hyphens.',
    validateInput: candidate => /^[a-z0-9][a-z0-9-]{1,63}$/.test(candidate) ? undefined : 'Use 2–64 lowercase letters, numbers or hyphens.',
  })
  if (id === undefined) return
  const name = await vscode.window.showInputBox({ title: 'New agent preset name', value: id })
  if (name === undefined) return
  await runner.copyPreset(picked.preset.id, id, name.trim() || undefined)
  const opened = await vscode.window.showInformationMessage(`Created user agent preset: ${id}`, 'Open for editing')
  if (opened === 'Open for editing') await runner.openPresetDocument(id)
}

async function openPluginCenter(runner: HostRunner, chat: ChatViewProvider): Promise<void> {
  const action = await vscode.window.showQuickPick([
    { label: 'Invoke a Harness Skill', value: 'invoke' as const, description: 'Start a new chat with a selected Skill attached.' },
    { label: 'Install an external Harness plugin', value: 'install' as const, description: 'Add a trusted package, tarball, GitHub spec, or local plugin folder to the web profile.' },
    { label: 'Remove an external Harness plugin', value: 'remove' as const, description: 'Uninstall a package previously added to the web profile.' },
    { label: 'Manage agent-preset plugins', value: 'presets' as const, description: 'Create, configure, enable, disable, or delete user-owned presets.' },
    { label: 'Open VS Code extension controls', value: 'extension' as const, description: 'Use VS Code to disable or uninstall this entire extension.' },
  ], { title: 'DeepSeek Harness Plugin Center' })
  if (action === undefined) return
  if (action.value === 'presets') {
    await manageAgentPresets(runner, chat)
    return
  }
  if (action.value === 'install') {
    const spec = await vscode.window.showInputBox({
      title: 'Install external Harness plugin',
      prompt: 'Package name, tarball, GitHub spec, or local folder path (one token; no shell characters).',
      validateInput: value => isProfilePackageSpec(value) ? undefined : 'Enter one package spec without spaces, shell characters, or command flags.',
    })
    if (spec === undefined) return
    const confirmed = await vscode.window.showWarningMessage(
      `Install external plugin “${spec.trim()}”? Its install scripts and runtime code can run on this computer outside Harness sandboxing.`,
      { modal: true },
      'Install trusted plugin',
    )
    if (confirmed !== 'Install trusted plugin') return
    await runner.installProfilePlugin(spec)
    void vscode.window.showInformationMessage('External Harness plugin installed. Start the next task to load the updated web profile.')
    return
  }
  if (action.value === 'remove') {
    const plugins = await runner.listProfilePlugins()
    if (plugins.length === 0) throw new Error('No externally installed Harness plugins are recorded for this web profile.')
    const picked = await vscode.window.showQuickPick(plugins.map(name => ({ label: name })), { title: 'Remove external Harness plugin' })
    if (picked === undefined) return
    const confirmed = await vscode.window.showWarningMessage(`Remove external plugin “${picked.label}” from the web profile?`, { modal: true }, 'Remove plugin')
    if (confirmed !== 'Remove plugin') return
    await runner.removeProfilePlugin(picked.label)
    void vscode.window.showInformationMessage('External Harness plugin removed. Start the next task to load the updated web profile.')
    return
  }
  if (action.value === 'extension') {
    await vscode.commands.executeCommand('workbench.view.extensions')
    void vscode.window.showInformationMessage('Search for “DeepSeek Harness”, then use its gear menu to disable or uninstall the VS Code extension.')
    return
  }
  const skills = await runner.listSkills()
  if (skills.length === 0) throw new Error('No Harness Skills are available for the current preset.')
  const picked = await vscode.window.showQuickPick(skills.map(skill => ({
    label: skill.name,
    description: skill.modelInvocable ? 'Model-invocable' : 'Manual',
    detail: skill.description,
    skill,
  })), { title: 'Invoke a Harness Skill' })
  if (picked !== undefined) await chat.invokeSkill(picked.skill.name, picked.skill.description)
}

function isProfilePackageSpec(value: string): boolean {
  const spec = value.trim()
  return spec.length > 0 && !spec.startsWith('-') && !/[\s&|<>^()%!"]/u.test(spec)
}

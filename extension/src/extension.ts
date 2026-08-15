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
import type { HarnessPreset, HarnessSkill } from './runner/runner'

const API_KEY_SECRET = 'deepseekHarness.apiKey'

/** Activates the independent DeepSeek Harness VS Code sidebar. */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('DeepSeek Harness')
  const locator = new HarnessSourceLocator(context.extensionUri)
  const configureApiKey = async (): Promise<boolean> => {
    const value = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      password: true,
      prompt: 'Enter the DeepSeek API key for this VS Code extension.',
      validateInput: candidate => candidate.trim().length >= 12 ? undefined : 'Enter a valid API key.',
    })
    if (value === undefined) return false
    await context.secrets.store(API_KEY_SECRET, value.trim())
    output.appendLine('DeepSeek API key stored in VS Code SecretStorage.')
    return true
  }
  await importBootstrapApiKey(context, output)
  const review = new PrewriteReviewService()
  const runner = new HostRunner(context, locator, async () => context.secrets.get(API_KEY_SECRET), review)
  const runtimeView = new RuntimeViewProvider(locator, context.secrets, runner)
  const capabilityView = new CapabilityViewProvider(() => runner.inspectCapabilities())
  const changeTracker = new WorkspaceChangeTracker()
  const changeDecorations = new WorkspaceChangeDecorationProvider(changeTracker)
  const setModel = async (model: string): Promise<void> => {
    if (runner.getStatus().state === 'running') throw new Error('Wait for the current Harness turn to finish before changing its model.')
    await vscode.workspace.getConfiguration('deepseekHarness').update('model', model, vscode.ConfigurationTarget.Global)
    output.appendLine(`DeepSeek model route changed to ${model}.`)
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
    async () => context.secrets.get(API_KEY_SECRET) !== undefined,
    () => vscode.workspace.getConfiguration('deepseekHarness').get<string>('model', 'deepseek-v4-flash'),
    setModel,
    permissionMode,
    setPermissionMode,
    versionSnapshots,
    toggleVersionSnapshots,
    changeTracker,
  )
  const treeView = vscode.window.createTreeView('deepseekHarness.runtime', { treeDataProvider: runtimeView })
  const capabilitiesTreeView = vscode.window.createTreeView('deepseekHarness.capabilities', { treeDataProvider: capabilityView })
  const refresh = (): void => {
    runtimeView.refresh()
  }

  context.subscriptions.push(output, locator, runner, review, runtimeView, capabilityView, changeTracker, changeDecorations, chatView, treeView, capabilitiesTreeView)
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(changeDecorations))
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(review.scheme, review))
  context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider(
    { scheme: 'file' },
    new DeepSeekInlineCompletionProvider(async () => context.secrets.get(API_KEY_SECRET)),
  ))
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('deepseekHarness.chat', chatView, {
    webviewOptions: { retainContextWhenHidden: true },
  }))
  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.refreshRuntime', refresh))
  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.refreshCapabilities', async () => {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Refreshing DeepSeek Harness capabilities' }, () => capabilityView.refresh())
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
      await capabilityView.refresh()
    } catch (error) {
      void vscode.window.showErrorMessage(`Unable to select agent preset: ${errorMessage(error)}`)
    }
  }))
  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.manageAgentPresets', async () => {
    try {
      await manageAgentPresets(runner, chatView)
      await capabilityView.refresh()
    } catch (error) {
      void vscode.window.showErrorMessage(`Unable to manage agent presets: ${errorMessage(error)}`)
    }
  }))
  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.configureApiKey', async () => {
    if (await configureApiKey()) refresh()
  }))
  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.openChat', () => chatView.focus()))
  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.newSession', () => chatView.newSession()))
  context.subscriptions.push(vscode.commands.registerCommand('deepseekHarness.stopRunner', async () => runner.stop()))
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
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Verifying DeepSeek connection', cancellable: false }, () => runner.verifyConnection())
      void vscode.window.showInformationMessage('DeepSeek connection verified. Your API key remains in VS Code SecretStorage.')
    } catch (error) {
      void vscode.window.showErrorMessage(`DeepSeek connection check failed: ${errorMessage(error)}`)
    }
  }))
  context.subscriptions.push(runner.onDidChangeStatus(status => {
    output.appendLine(`Runner: ${status.state} — ${status.detail}`)
    refresh()
  }))

  const source = await locator.inspect()
  output.appendLine(`Harness source: ${source.state}${source.version === undefined ? '' : ` (${source.version})`}`)
}

/** VS Code disposes registered resources during deactivation. */
export function deactivate(): void {}

/** Imports an explicitly configured local credential only when SecretStorage is empty. */
async function importBootstrapApiKey(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  if (await context.secrets.get(API_KEY_SECRET) !== undefined) return
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
    await context.secrets.store(API_KEY_SECRET, value)
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
    { label: 'Open a user preset for editing', value: 'open' as const, description: 'Only user-owned presets can be edited.' },
  ], { title: 'Harness agent presets' })
  if (action === undefined) return
  const candidates = action.value === 'open'
    ? presets.filter(preset => preset.trust === 'user' && preset.broken === undefined)
    : presets.filter(preset => preset.broken === undefined)
  if (candidates.length === 0) throw new Error(action.value === 'open' ? 'No user-owned editable presets are available yet.' : 'No usable agent presets are available.')
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

import * as vscode from 'vscode'
import type { AgentRunner } from './runner/runner'
import type { HarnessSourceLocator, HarnessSourceStatus } from './runner/source-locator'
import { ProviderManager } from './provider-manager'

/** Sidebar tree showing the local prerequisites for the upcoming Runner bridge. */
export class RuntimeViewProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>()
  private readonly sourceListener: vscode.Disposable
  private readonly runnerListener: vscode.Disposable

  /** Emits when the view should be refreshed. */
  readonly onDidChangeTreeData = this.changeEmitter.event

  constructor(
    private readonly locator: HarnessSourceLocator,
    private readonly secrets: vscode.SecretStorage,
    private readonly runner: AgentRunner,
    private readonly providers: ProviderManager,
  ) {
    this.sourceListener = locator.onDidChange(() => this.refresh())
    this.runnerListener = this.runner.onDidChangeStatus(() => this.refresh())
  }

  /** Rebuilds the prerequisite rows. */
  refresh(): void {
    this.changeEmitter.fire()
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element !== undefined) return []
    const source = await this.locator.inspect()
    const apiKey = await this.secrets.get('deepseekHarness.apiKey')
    return [refreshItem(), sourceItem(source), apiKeyItem(apiKey !== undefined), selectedModelItem(this.providers), providerItem(this.providers), runnerItem(this.runner)]
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element
  }

  dispose(): void {
    this.sourceListener.dispose()
    this.runnerListener.dispose()
    this.changeEmitter.dispose()
  }
}

function refreshItem(): vscode.TreeItem {
  const item = new vscode.TreeItem('Refresh Runtime now', vscode.TreeItemCollapsibleState.None)
  item.description = 'Recheck source, key and local Host status.'
  item.tooltip = 'Refresh the local Harness source, API-key and Runner status.'
  item.iconPath = new vscode.ThemeIcon('refresh')
  item.command = { command: 'deepseekHarness.refreshRuntime', title: 'Refresh Runtime Status' }
  return item
}

function sourceItem(source: HarnessSourceStatus): vscode.TreeItem {
  const item = new vscode.TreeItem('Harness source', vscode.TreeItemCollapsibleState.None)
  item.description = source.state === 'ready' ? source.version ?? 'ready' : source.state
  item.tooltip = `${source.root.fsPath}\n${source.detail}`
  item.iconPath = new vscode.ThemeIcon(source.state === 'ready' ? 'check' : 'error')
  if (source.state !== 'ready') {
    item.command = { command: 'deepseekHarness.selectHarnessFolder', title: 'Select Harness Folder' }
  }
  return item
}

function apiKeyItem(configured: boolean): vscode.TreeItem {
  const item = new vscode.TreeItem('DeepSeek API key', vscode.TreeItemCollapsibleState.None)
  item.description = configured ? 'configured' : 'not configured'
  item.tooltip = configured ? 'Stored in VS Code SecretStorage.' : 'Configure an API key before starting the Runner.'
  item.iconPath = new vscode.ThemeIcon(configured ? 'key' : 'key')
  item.command = {
    command: 'deepseekHarness.configureApiKey',
    title: 'Configure DeepSeek API Key',
  }
  return item
}

function selectedModelItem(providers: ProviderManager): vscode.TreeItem {
  const selection = providers.selected()
  const label = providers.modelOptions().find(option => option.provider === selection.provider && option.model === selection.model)?.label
    ?? `${selection.provider} · ${selection.model}`
  const item = new vscode.TreeItem('Selected model', vscode.TreeItemCollapsibleState.None)
  item.description = label
  item.tooltip = 'Choose a model from the chat composer, or configure model providers here.'
  item.iconPath = new vscode.ThemeIcon('symbol-method')
  item.command = { command: 'deepseekHarness.manageModelProviders', title: 'Manage Model Providers' }
  return item
}

function providerItem(providers: ProviderManager): vscode.TreeItem {
  const item = new vscode.TreeItem('Model providers', vscode.TreeItemCollapsibleState.None)
  item.description = providers.configuredSummary()
  item.tooltip = 'Configure OpenAI, Anthropic, Google Gemini, or an OpenAI-compatible API. Keys are stored in VS Code SecretStorage.'
  item.iconPath = new vscode.ThemeIcon('settings-gear')
  item.command = { command: 'deepseekHarness.manageModelProviders', title: 'Manage Model Providers' }
  return item
}

function runnerItem(runner: AgentRunner): vscode.TreeItem {
  const status = runner.getStatus()
  const item = new vscode.TreeItem('Local Runner', vscode.TreeItemCollapsibleState.None)
  item.description = status.state
  item.tooltip = status.detail
  item.iconPath = new vscode.ThemeIcon(status.state === 'error' ? 'error' : status.state === 'running' ? 'sync~spin' : 'server')
  item.command = status.state === 'stopped'
    ? { command: 'deepseekHarness.startRunner', title: 'Start Local Runner' }
    : { command: 'deepseekHarness.stopRunner', title: 'Stop Local Runner' }
  return item
}

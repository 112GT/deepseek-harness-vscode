import * as vscode from 'vscode'
import type { CapabilityViewProvider, HotReloadState } from './capability-view'
import type { AgentRunner } from './runner/runner'
import type { HarnessSourceLocator } from './runner/source-locator'

type ReloadArea = 'skills' | 'presets' | 'settings'

/**
 * Keeps the native Harness control centre aligned with file-backed Harness
 * capabilities. Harness already watches these files; this companion only
 * updates the VS Code presentation after a safe point between turns.
 */
export class CapabilitiesHotReloader implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = []
  private readonly watchers: vscode.FileSystemWatcher[] = []
  private readonly watcherListeners: vscode.Disposable[] = []
  private readonly pending = new Set<ReloadArea>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private refreshing = false
  private watchedSources: readonly string[] = []
  private lastUpdated: string | undefined
  private lastDetail = 'Starting capability watchers…'

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly locator: HarnessSourceLocator,
    private readonly runner: AgentRunner,
    private readonly view: CapabilityViewProvider,
    private readonly output: vscode.OutputChannel,
  ) {}

  async start(): Promise<void> {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('deepseekHarness.hotReload')) void this.rebuildWatchers()
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.rebuildWatchers()),
      this.locator.onDidChange(() => void this.rebuildWatchers()),
      this.runner.onDidChangeStatus(status => {
        if (status.state === 'ready' && this.pending.size > 0) this.schedule()
      }),
    )
    await this.rebuildWatchers()
  }

  async refreshNow(): Promise<void> {
    this.pending.clear()
    await this.refresh('Manual refresh complete.')
  }

  async toggle(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('deepseekHarness.hotReload')
    const enabled = configuration.get<boolean>('enabled', true)
    await configuration.update('enabled', !enabled, vscode.ConfigurationTarget.Global)
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.disposeWatchers()
    for (const disposable of this.disposables.splice(0)) disposable.dispose()
  }

  private async rebuildWatchers(): Promise<void> {
    this.disposeWatchers()
    this.watchedSources = []
    if (!this.enabled()) {
      this.lastDetail = 'Auto refresh is off. Enable it to watch Skills, presets and settings.'
      this.publish()
      return
    }

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      this.watchSkillRoots(folder, 'Workspace Skills')
    }

    const hostHome = vscode.Uri.joinPath(this.context.globalStorageUri, 'host-home')
    this.watchSkillRoots(hostHome, 'User Skills')
    this.watch(new vscode.RelativePattern(hostHome, '.agent-presets/**'), 'User presets', 'presets')
    this.watch(new vscode.RelativePattern(hostHome, 'settings.yaml'), 'Harness settings.yaml', 'settings')

    const source = await this.locator.inspect()
    if (source.state === 'ready') this.watchSkillRoots(source.root, 'Bundled Skills')

    this.lastDetail = this.watchedSources.length === 0
      ? 'No workspace is open. User Skills and Harness settings remain watched.'
      : 'Listening to ' + String(this.watchedSources.length) + ' capability sources.'
    this.publish()
  }

  private watch(pattern: vscode.GlobPattern, label: string, area: ReloadArea): void {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern)
    const changed = (): void => this.detect(area, label)
    this.watchers.push(watcher)
    this.watcherListeners.push(watcher.onDidCreate(changed), watcher.onDidChange(changed), watcher.onDidDelete(changed))
    if (!this.watchedSources.includes(label)) this.watchedSources = [...this.watchedSources, label]
  }

  private watchSkillRoots(root: vscode.Uri | vscode.WorkspaceFolder, label: string): void {
    this.watch(new vscode.RelativePattern(root, '.agents/skills/**'), label, 'skills')
    this.watch(new vscode.RelativePattern(root, '.dsh/skills/**'), label, 'skills')
  }

  private detect(area: ReloadArea, label: string): void {
    if (!this.enabled()) return
    this.pending.add(area)
    this.lastDetail = label + ' changed. Refreshing after the current task finishes.'
    this.output.appendLine('Harness hot reload: detected ' + area + ' change in ' + label + '.')
    this.publish()
    if (this.runner.getStatus().state === 'ready') this.schedule()
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    const delay = vscode.workspace.getConfiguration('deepseekHarness.hotReload').get<number>('debounceMs', 750)
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.runner.getStatus().state === 'ready') void this.refresh('Automatic refresh complete.')
    }, Math.max(100, delay))
  }

  private async refresh(prefix: string): Promise<void> {
    if (this.refreshing) return
    this.refreshing = true
    const areas = [...this.pending]
    this.pending.clear()
    this.lastDetail = 'Refreshing Skills, presets and providers…'
    this.publish()
    try {
      const result = await this.view.refresh()
      if (!result.ok) throw new Error(result.detail)
      this.lastUpdated = new Date().toLocaleTimeString()
      this.lastDetail = prefix + ' ' + result.detail
      this.output.appendLine('Harness hot reload: ' + this.lastDetail)
    } catch (error) {
      for (const area of areas) this.pending.add(area)
      this.lastDetail = 'Refresh failed: ' + errorMessage(error)
      this.output.appendLine('Harness hot reload failed: ' + errorMessage(error))
    } finally {
      this.refreshing = false
      this.publish()
    }
  }

  private enabled(): boolean {
    return vscode.workspace.getConfiguration('deepseekHarness.hotReload').get<boolean>('enabled', true)
  }

  private publish(): void {
    const state: HotReloadState = {
      enabled: this.enabled(),
      watchedSources: this.watchedSources,
      pendingAreas: [...this.pending],
      lastUpdated: this.lastUpdated,
      detail: this.lastDetail,
    }
    this.view.setHotReloadState(state)
  }

  private disposeWatchers(): void {
    for (const watcher of this.watchers.splice(0)) watcher.dispose()
    for (const listener of this.watcherListeners.splice(0)) listener.dispose()
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

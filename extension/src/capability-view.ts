import * as vscode from 'vscode'
import type { HarnessCapabilitiesSnapshot, HarnessPreset, HarnessSkill } from './runner/runner'

type CapabilityNode = GroupNode | LeafNode

interface GroupNode {
  readonly kind: 'group'
  readonly label: string
  readonly description: string
  readonly children: readonly LeafNode[]
}

interface LeafNode {
  readonly kind: 'leaf'
  readonly label: string
  readonly description?: string
  readonly icon?: string
  readonly command?: vscode.Command
}

/**
 * A native control centre over the Host APIs that the extension can actually
 * call. Every refresh is a fresh Host query; action rows remain visible even
 * after a successful query so users never need to discover a title-bar icon.
 */
export class CapabilityViewProvider implements vscode.TreeDataProvider<CapabilityNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<CapabilityNode | undefined>()
  readonly onDidChangeTreeData = this.changed.event
  private snapshot: HarnessCapabilitiesSnapshot | undefined
  private error: string | undefined

  constructor(private readonly load: () => Promise<HarnessCapabilitiesSnapshot>) {}

  getTreeItem(node: CapabilityNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, node.kind === 'group' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None)
    item.description = node.description
    item.tooltip = node.description === undefined ? node.label : `${node.label}\n${node.description}`
    item.iconPath = new vscode.ThemeIcon(node.kind === 'group' ? 'symbol-namespace' : node.icon ?? 'circle-small-filled')
    if (node.kind === 'leaf') item.command = node.command
    if (node.kind === 'group') item.contextValue = 'deepseekHarnessCapabilityGroup'
    return item
  }

  getChildren(node?: CapabilityNode): CapabilityNode[] {
    if (node?.kind === 'group') return [...node.children]
    if (node !== undefined) return []
    const controls = controlNodes()
    if (this.error !== undefined) return [...controls, { kind: 'leaf', label: 'Unable to load capabilities', description: this.error, icon: 'error' }]
    if (this.snapshot === undefined) return [...controls, { kind: 'leaf', label: 'Refresh Harness now', description: 'Load skills, providers, presets and sub-agents.', icon: 'info' }]
    return [...controls, ...groups(this.snapshot)]
  }

  async refresh(): Promise<void> {
    this.error = undefined
    try {
      this.snapshot = await this.load()
    } catch (error) {
      this.snapshot = undefined
      this.error = error instanceof Error ? error.message : String(error)
    }
    this.changed.fire(undefined)
  }

  dispose(): void {
    this.changed.dispose()
  }

}

function controlNodes(): readonly LeafNode[] {
  return [
    {
      kind: 'leaf', label: 'Refresh Harness now', description: 'Query the local Host again.', icon: 'refresh',
      command: { command: 'deepseekHarness.refreshCapabilities', title: 'Refresh Harness capabilities' },
    },
    {
      kind: 'leaf', label: 'Open Harness settings.yaml', description: 'Edit user Harness settings in VS Code.', icon: 'settings-gear',
      command: { command: 'deepseekHarness.openHarnessSettings', title: 'Open Harness settings' },
    },
    {
      kind: 'leaf', label: 'Manage agent presets', description: 'Select or copy a preset for a new session.', icon: 'tools',
      command: { command: 'deepseekHarness.manageAgentPresets', title: 'Manage Harness agent presets' },
    },
    {
      kind: 'leaf', label: 'Open extension settings', description: 'Model, access mode, source folder and editor options.', icon: 'settings',
      command: { command: 'deepseekHarness.openExtensionSettings', title: 'Open DeepSeek Harness settings' },
    },
  ]
}

function groups(snapshot: HarnessCapabilitiesSnapshot): readonly GroupNode[] {
  return [
    group('Model providers', snapshot.providers.map(label => ({
      kind: 'leaf', label, description: 'Provider is configured by Harness settings.yaml.', icon: 'hubot',
    }))),
    group('Skills', snapshot.skills.map(skill => ({
      kind: 'leaf', label: skill.name,
      description: `${skill.modelInvocable ? 'Model-invocable' : 'Manual'}${skill.description === undefined ? '' : ` — ${skill.description}`}`,
      icon: 'rocket',
      command: { command: 'deepseekHarness.invokeSkill', title: `Run skill ${skill.name}`, arguments: [skill] },
    }))),
    group('Agent presets', snapshot.presets.map(preset => ({
      kind: 'leaf', label: preset.name,
      description: preset.broken ?? `${preset.trust}${preset.isDefault ? ' · default' : ''}${preset.description === undefined ? '' : ` — ${preset.description}`}`,
      icon: preset.broken === undefined ? 'symbol-event' : 'error',
      command: preset.broken === undefined
        ? { command: 'deepseekHarness.selectAgentPreset', title: `Start session with ${preset.name}`, arguments: [preset] }
        : undefined,
    }))),
    group('Sub-agents', snapshot.subagents.map(agent => ({
      kind: 'leaf', label: agent.id, description: agent.status, icon: 'person',
    }))),
  ]
}

function group(label: string, children: readonly LeafNode[]): GroupNode {
  return { kind: 'group', label, description: children.length === 0 ? 'None available' : `${String(children.length)} available`, children }
}

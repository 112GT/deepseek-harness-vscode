import * as vscode from 'vscode'
import type { PromptAttachment, RunnerEvent } from './protocol'
import type { HarnessRunnerStatus } from './harness-runner'

export interface RunnerSessionSummary {
  readonly id: string
  readonly title: string
  readonly updatedAt?: string
}

export interface RunnerHistoryEntry {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/** A short, Host-confirmed result from a Harness slash command. */
export interface RunnerCommandResult {
  readonly text: string
}

export interface HarnessCapabilitiesSnapshot {
  readonly providers: readonly string[]
  readonly skills: readonly HarnessSkill[]
  readonly subagents: readonly { readonly id: string; readonly status?: string }[]
  readonly presets: readonly HarnessPreset[]
}

export interface HarnessSkill {
  readonly name: string
  readonly description?: string
  readonly modelInvocable: boolean
}

export interface HarnessPreset {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly trust: 'system' | 'user'
  readonly isDefault: boolean
  readonly broken?: string
}

/**
 * Presentation-facing lifecycle shared by the legacy SDK demo and the Host
 * sidecar. The sidebar deliberately depends on this small surface instead of
 * a transport implementation.
 */
export interface AgentRunner extends vscode.Disposable {
  readonly onDidEvent: vscode.Event<RunnerEvent>
  readonly onDidChangeStatus: vscode.Event<HarnessRunnerStatus>
  getStatus(): HarnessRunnerStatus
  newSession(): string
  prompt(content: string, attachments: readonly PromptAttachment[]): Promise<void>
  cancelTurn(): Promise<void>
  compactContext(): Promise<RunnerCommandResult>
  stop(): Promise<void>
  prepare(): Promise<void>
  startLocalHost(): Promise<void>
  listSessions(): Promise<readonly RunnerSessionSummary[]>
  resumeSession(id: string): Promise<readonly RunnerHistoryEntry[]>
  inspectCapabilities(): Promise<HarnessCapabilitiesSnapshot>
  listSkills(): Promise<readonly HarnessSkill[]>
  listPresets(): Promise<readonly HarnessPreset[]>
  selectPreset(id: string): Promise<void>
  copyPreset(from: string, id: string, name?: string): Promise<void>
  openPresetDocument(id: string): Promise<void>
  removePreset(id: string): Promise<void>
  openHarnessSettings(): Promise<void>
}

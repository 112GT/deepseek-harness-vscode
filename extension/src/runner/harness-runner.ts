import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import * as vscode from 'vscode'
import type { PromptAttachment, PromptRequest, RunnerEvent } from './protocol'
import { JsonRpcRuntime, type JsonRpcNotification } from './json-rpc-runtime'
import type { HarnessSourceLocator, HarnessSourceStatus } from './source-locator'
import type { HarnessCapabilitiesSnapshot, HarnessPreset, HarnessSkill, RunnerHistoryEntry, RunnerSessionSummary } from './runner'

const SDK_RUNTIME = ['packages', 'examples', 'jsonrpc-demo', 'lib', 'bin.js'] as const
const SDK_CONFIG = ['examples', 'jsonrpc-agent', 'cordis.yml'] as const

/** Snapshot of the locally owned Harness process. */
export interface HarnessRunnerStatus {
  readonly state: 'stopped' | 'starting' | 'ready' | 'running' | 'error'
  readonly detail: string
  readonly sessionId: string
}

/**
 * Launches the existing Harness JSON-RPC demo composition and translates its
 * durable SDK notifications into presentation-neutral extension events.
 */
export class HarnessRunner implements vscode.Disposable {
  private readonly eventEmitter = new vscode.EventEmitter<RunnerEvent>()
  private readonly statusEmitter = new vscode.EventEmitter<HarnessRunnerStatus>()
  private runtime: JsonRpcRuntime | undefined
  private activeSessionId = randomUUID()
  private status: HarnessRunnerStatus = {
    state: 'stopped',
    detail: 'Local Runner is not started.',
    sessionId: this.activeSessionId,
  }

  /** Presentation-neutral events from the active Harness run. */
  readonly onDidEvent = this.eventEmitter.event
  /** Emits whenever the sidebar status changes. */
  readonly onDidChangeStatus = this.statusEmitter.event

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly locator: HarnessSourceLocator,
    private readonly apiKey: () => Promise<string | undefined>,
  ) {}

  /** Returns the current process and session state. */
  getStatus(): HarnessRunnerStatus {
    return this.status
  }

  /** Starts an empty session without launching a model request. */
  newSession(): string {
    if (this.status.state === 'running') throw new Error('Wait for the current Harness turn to finish before starting a new session.')
    this.activeSessionId = randomUUID()
    this.setStatus(this.runtime === undefined ? 'stopped' : 'ready', 'New session is ready.', this.activeSessionId)
    return this.activeSessionId
  }

  /** Queues one user request on the active, workspace-bound Harness session. */
  async prompt(content: string, attachments: readonly PromptAttachment[]): Promise<void> {
    if (content.trim().length === 0) return
    if (this.status.state === 'running') throw new Error('Harness is still completing the previous turn.')
    const runtime = await this.start()
    const request: PromptRequest = {
      sessionId: this.activeSessionId,
      workspaceFolder: this.workspaceFolder(),
      content: content.trim(),
      attachments,
    }
    this.setStatus('running', 'Harness is working.', request.sessionId)
    try {
      await runtime.request('session/prompt', {
        sessionId: request.sessionId,
        contentBlocks: [{ type: 'text', text: modelInput(request) }],
      })
    } catch (error) {
      const message = errorMessage(error)
      this.setStatus('error', message, request.sessionId)
      this.eventEmitter.fire({ kind: 'error', sessionId: request.sessionId, message })
    }
  }

  /** Stops the owned Runner. The upstream SDK has no per-turn cancellation. */
  async stop(): Promise<void> {
    const runtime = this.runtime
    this.runtime = undefined
    if (runtime !== undefined) await runtime.stop()
    this.setStatus('stopped', 'Local Runner stopped.', this.activeSessionId)
  }

  /** Legacy JSON-RPC has no per-turn cancellation, so interruption owns the process. */
  async cancelTurn(): Promise<void> {
    await this.stop()
  }

  /** Builds the copied Harness checkout when the published SDK entry is absent. */
  async prepare(): Promise<void> {
    const source = await this.requireSource()
    if (this.runtime !== undefined) throw new Error('Stop the local Runner before preparing Harness.')
    this.setStatus('starting', 'Installing and building the local Harness source…', this.activeSessionId)
    try {
      await runCommand(corepackCommand(), ['pnpm', 'install'], source.root.fsPath)
      await runCommand(corepackCommand(), ['pnpm', 'run', 'build'], source.root.fsPath)
      this.setStatus('stopped', 'Local Harness runtime is built and ready.', this.activeSessionId)
    } catch (error) {
      const message = errorMessage(error)
      this.setStatus('error', message, this.activeSessionId)
      throw error
    }
  }

  /** The legacy demo transport has no durable Host API. */
  async listSessions(): Promise<readonly RunnerSessionSummary[]> {
    return []
  }

  /** The legacy demo transport cannot restore a durable session. */
  async resumeSession(_id: string): Promise<readonly RunnerHistoryEntry[]> {
    throw new Error('Session history requires the local Harness Host transport.')
  }

  /** The legacy demo transport does not expose Host capability discovery. */
  async inspectCapabilities(): Promise<HarnessCapabilitiesSnapshot> {
    return { providers: [], skills: [], subagents: [], presets: [] }
  }

  async listSkills(): Promise<readonly HarnessSkill[]> {
    return []
  }

  async listPresets(): Promise<readonly HarnessPreset[]> {
    return []
  }

  async selectPreset(_id: string): Promise<void> {
    throw new Error('Agent presets require the local Harness Host transport.')
  }

  async copyPreset(_from: string, _id: string, _name?: string): Promise<void> {
    throw new Error('Agent presets require the local Harness Host transport.')
  }

  async openPresetDocument(_id: string): Promise<void> {
    throw new Error('Agent presets require the local Harness Host transport.')
  }

  async openHarnessSettings(): Promise<void> {
    throw new Error('Harness settings require the local Harness Host transport.')
  }

  dispose(): void {
    void this.stop()
    this.eventEmitter.dispose()
    this.statusEmitter.dispose()
  }

  private async start(): Promise<JsonRpcRuntime> {
    if (this.runtime !== undefined) return this.runtime
    const source = await this.requireSource()
    const apiKey = await this.apiKey()
    if (apiKey === undefined) throw new Error('Configure a DeepSeek API key before starting the local Runner.')
    if (vscode.workspace.getConfiguration('deepseekHarness').get<string>('runnerTransport') === 'remote') {
      throw new Error('Remote Runner is not implemented yet. Select the local Runner in Settings.')
    }
    const entry = path.join(source.root.fsPath, ...SDK_RUNTIME)
    const config = path.join(source.root.fsPath, ...SDK_CONFIG)
    await requireFile(entry, 'The Harness runtime is not built yet. Run “DeepSeek Harness: Prepare Local Runtime”.')
    await requireFile(config, 'The copied Harness JSON-RPC configuration is missing.')
    const sessionRoot = path.join(this.context.globalStorageUri.fsPath, 'sessions')
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(sessionRoot))
    this.setStatus('starting', 'Starting local Harness Runner…', this.activeSessionId)
    const node = vscode.workspace.getConfiguration('deepseekHarness').get<string>('nodePath', 'node').trim() || 'node'
    const runtime = new JsonRpcRuntime({
      command: node,
      args: [entry, config],
      cwd: source.root.fsPath,
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: apiKey,
        DSH_CWD: this.workspaceFolder(),
        DSH_SESSION_ROOT: sessionRoot,
      },
    }, notification => this.handleNotification(notification), message => {
      this.runtime = undefined
      this.setStatus('error', message, this.activeSessionId)
      this.eventEmitter.fire({ kind: 'error', sessionId: this.activeSessionId, message })
    })
    try {
      const result = await runtime.request('initialize', {
        cwd: this.workspaceFolder(),
        provider: 'deepseek-official',
        model: vscode.workspace.getConfiguration('deepseekHarness').get<string>('model', 'deepseek-v4-flash'),
      })
      assertServerIdentity(result)
      this.runtime = runtime
      this.setStatus('ready', 'Local Harness Runner is ready.', this.activeSessionId)
      return runtime
    } catch (error) {
      await runtime.stop()
      throw error
    }
  }

  private handleNotification(notification: JsonRpcNotification): void {
    if (notification.method === 'session.status') {
      const payload = asRecord(notification.params)
      if (payload?.sessionId !== this.activeSessionId) return
      if (payload.status === 'idle') this.setStatus('ready', 'Harness is ready.', this.activeSessionId)
      if (payload.status === 'running') this.setStatus('running', 'Harness is working.', this.activeSessionId)
      return
    }
    if (notification.method === 'subagent.started') {
      const payload = asRecord(notification.params)
      if (payload?.parentSessionId !== this.activeSessionId) return
      const childId = text(payload.childSessionId)
      if (childId !== undefined) this.eventEmitter.fire({ kind: 'tool-call', sessionId: this.activeSessionId, callId: childId, title: 'Sub-agent started' })
      return
    }
    if (notification.method === 'subagent.finished') {
      const payload = asRecord(notification.params)
      if (payload?.parentSessionId !== this.activeSessionId) return
      const childId = text(payload.childSessionId)
      if (childId !== undefined) this.eventEmitter.fire({
        kind: 'tool-result',
        sessionId: this.activeSessionId,
        callId: childId,
        summary: `Sub-agent ${text(payload.status) ?? 'finished'}.`,
        isError: payload.status === 'error',
      })
      return
    }
    if (notification.method !== 'session.event') return
    const payload = asRecord(notification.params)
    const sessionId = text(payload?.sessionId)
    const event = asRecord(payload?.event)
    const type = text(event?.type)
    const data = asRecord(event?.data)
    if (sessionId === undefined || type === undefined || data === undefined) return
    this.mapSessionEvent(sessionId, type, data)
  }

  private mapSessionEvent(sessionId: string, type: string, data: Record<string, unknown>): void {
    if (sessionId !== this.activeSessionId && type !== 'tool/call' && type !== 'tool/result') return
    switch (type) {
      case 'assistant/chunk': {
        if (sessionId !== this.activeSessionId) return
        const chunk = asRecord(data.chunk)
        if (chunk?.type === 'text-delta') {
          const value = text(chunk.text)
          if (value !== undefined) this.eventEmitter.fire({ kind: 'assistant-delta', sessionId, text: value })
        }
        if (chunk?.type === 'reasoning-delta') {
          const value = text(chunk.text)
          if (value !== undefined) this.eventEmitter.fire({ kind: 'reasoning-delta', sessionId, text: value })
        }
        return
      }
      case 'assistant/message': {
        if (sessionId !== this.activeSessionId) return
        const message = asRecord(data.message)
        const markdown = contentText(message?.content)
        if (markdown.length > 0) this.eventEmitter.fire({ kind: 'assistant-message', sessionId, markdown })
        this.emitUsage(sessionId, data.usage)
        return
      }
      case 'tool/call': {
        const callId = text(data.callId)
        const title = text(data.name)
        if (callId !== undefined && title !== undefined) {
          this.eventEmitter.fire({ kind: 'tool-call', sessionId: this.activeSessionId, callId, title, detail: text(data.arguments) })
        }
        return
      }
      case 'tool/result': {
        const message = asRecord(data.message)
        const callId = text(message?.source && asRecord(message.source)?.callId)
        if (callId !== undefined) {
          const summary = contentText(message?.content)
          this.eventEmitter.fire({
            kind: 'tool-result',
            sessionId: this.activeSessionId,
            callId,
            summary: truncate(summary, 2_000),
            isError: data.error !== undefined || toolOutputFailed(summary),
          })
        }
        return
      }
      case 'todo/write': {
        if (sessionId !== this.activeSessionId) return
        const todos = todoItems(data.todos)
        this.eventEmitter.fire({ kind: 'todo', sessionId, todos })
        return
      }
      default:
        return
    }
  }

  private emitUsage(sessionId: string, value: unknown): void {
    const usage = asRecord(value)
    const inputTokens = number(usage?.inputTokens)
    const outputTokens = number(usage?.outputTokens)
    if (inputTokens === undefined || outputTokens === undefined) return
    this.eventEmitter.fire({ kind: 'usage', sessionId, inputTokens, outputTokens })
  }

  private async requireSource(): Promise<HarnessSourceStatus> {
    const source = await this.locator.inspect()
    if (source.state !== 'ready') throw new Error(source.detail)
    return source
  }

  private workspaceFolder(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
  }

  private setStatus(state: HarnessRunnerStatus['state'], detail: string, sessionId: string): void {
    this.status = { state, detail, sessionId }
    this.statusEmitter.fire(this.status)
  }
}

function modelInput(request: PromptRequest): string {
  const textual = request.attachments.filter((attachment): attachment is Exclude<PromptAttachment, { kind: 'image' }> => attachment.kind !== 'image')
  if (textual.length === 0) return request.content
  const context = textual.map(attachment => [
    `--- ${attachment.label} ---`,
    attachment.content,
    '--- end editor context ---',
  ].join('\n')).join('\n\n')
  return `${request.content}\n\nThe following editor context was explicitly attached by the user:\n${context}`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function todoItems(value: unknown): { readonly content: string; readonly status: 'pending' | 'in_progress' | 'completed' }[] {
  if (!Array.isArray(value)) return []
  const todos: { content: string; status: 'pending' | 'in_progress' | 'completed' }[] = []
  for (const raw of value) {
    const item = asRecord(raw)
    const content = text(item?.content)
    const status = text(item?.status)
    if (content === undefined || (status !== 'pending' && status !== 'in_progress' && status !== 'completed')) continue
    todos.push({ content, status })
  }
  return todos
}

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value.flatMap(contentBlockText).join('\n')
}

function contentBlockText(block: unknown): string[] {
  const record = asRecord(block)
  if (record?.type === 'text' && typeof record.text === 'string') return [record.text]
  if (record?.type === 'tool-result') {
    const nested = contentText(record.content)
    return nested.length === 0 ? [] : [nested]
  }
  return []
}

function toolOutputFailed(summary: string): boolean {
  return /\[exit code:\s*[1-9]\d*\]/.test(summary) || summary.startsWith('Error:')
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`
}

function assertServerIdentity(value: unknown): void {
  const serverInfo = asRecord(asRecord(value)?.serverInfo)
  if (serverInfo?.name !== 'deepseek-harness-sdk-runtime') throw new Error('The local process is not a compatible DeepSeek Harness SDK Runner.')
}

async function requireFile(file: string, message: string): Promise<void> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(file))
  } catch {
    throw new Error(message)
  }
}

function corepackCommand(): string {
  return process.platform === 'win32' ? 'corepack.cmd' : 'corepack'
}

function runCommand(command: string, args: readonly string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const process = spawn(command, [...args], { cwd, env: corepackEnvironment(), stdio: 'pipe', windowsHide: true })
    let diagnostics = ''
    process.stdout.on('data', chunk => { diagnostics = retainTail(diagnostics, String(chunk)) })
    process.stderr.on('data', chunk => { diagnostics = retainTail(diagnostics, String(chunk)) })
    process.once('error', error => reject(new Error(`Unable to run ${command}: ${error.message}`)))
    process.once('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} failed with exit code ${String(code)}.${diagnostics.length === 0 ? '' : ` ${diagnostics}`}`))
    })
  })
}

function retainTail(current: string, next: string): string {
  const combined = `${current}${next}`.trim()
  return combined.length <= 2_000 ? combined : combined.slice(-2_000)
}

function corepackEnvironment(): NodeJS.ProcessEnv {
  if (process.platform !== 'win32' || process.env.LOCALAPPDATA === undefined) return process.env
  const shim = path.join(process.env.LOCALAPPDATA, 'Programs', 'node-corepack')
  const currentPath = process.env.Path ?? process.env.PATH ?? ''
  return { ...process.env, Path: `${shim}${path.delimiter}${currentPath}` }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

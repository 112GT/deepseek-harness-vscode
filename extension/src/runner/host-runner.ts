import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import WebSocket from 'ws'
import * as vscode from 'vscode'
import type { PromptAttachment, RunnerEvent } from './protocol'
import type { HarnessRunnerStatus } from './harness-runner'
import type { HarnessSourceLocator, HarnessSourceStatus } from './source-locator'
import type { AgentRunner, HarnessCapabilitiesSnapshot, HarnessPreset, HarnessSkill, RunnerHistoryEntry, RunnerSessionSummary } from './runner'
import { PrewriteReviewService } from '../prewrite-review'

const CLI_RUNTIME = ['apps', 'cli', 'lib', 'bin.js'] as const
const SIDECAR_READY_TIMEOUT_MS = 30_000

interface RpcFailure {
  readonly code?: unknown
  readonly message?: unknown
}

interface RpcResult {
  readonly ok?: unknown
  readonly value?: unknown
  readonly error?: RpcFailure
}

interface HostEnvelope {
  readonly type?: unknown
  readonly rpcId?: unknown
  readonly payload?: unknown
}

interface ConnectionProbe {
  readonly sessionId: string
  output: string
  readonly resolve: () => void
  readonly reject: (error: Error) => void
  readonly timeout: ReturnType<typeof setTimeout>
}

/**
 * Owns the full Harness Host sidecar and talks to its documented HTTP and
 * WebSocket API. This is the extension's real third frontend, not a browser
 * iframe and not the narrow JSON-RPC demo.
 */
export class HostRunner implements AgentRunner {
  private readonly eventEmitter = new vscode.EventEmitter<RunnerEvent>()
  private readonly statusEmitter = new vscode.EventEmitter<HarnessRunnerStatus>()
  private child: ChildProcessWithoutNullStreams | undefined
  private mux: WebSocket | undefined
  private host: WebSocket | undefined
  private baseUrl: string | undefined
  private activeSessionId: string = randomUUID()
  private readonly approvalToolCalls = new Map<string, string>()
  private readonly toolArguments = new Map<string, string>()
  private probe: ConnectionProbe | undefined
  private stopping = false
  private status: HarnessRunnerStatus = {
    state: 'stopped',
    detail: 'Local Harness Host is not started.',
    sessionId: this.activeSessionId,
  }

  readonly onDidEvent = this.eventEmitter.event
  readonly onDidChangeStatus = this.statusEmitter.event

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly locator: HarnessSourceLocator,
    private readonly apiKey: () => Promise<string | undefined>,
    private readonly review: PrewriteReviewService,
  ) {}

  getStatus(): HarnessRunnerStatus {
    return this.status
  }

  /** Selects a future Host session while leaving previous durable sessions intact. */
  newSession(): string {
    if (this.status.state === 'running') throw new Error('Wait for the current Harness turn to finish before starting a new session.')
    this.activeSessionId = randomUUID()
    this.approvalToolCalls.clear()
    this.toolArguments.clear()
    this.setStatus(this.child === undefined ? 'stopped' : 'ready', 'New Host session is ready.', this.activeSessionId)
    return this.activeSessionId
  }

  /** Creates the named Host session on demand and queues its user prompt. */
  async prompt(content: string, attachments: readonly PromptAttachment[]): Promise<void> {
    if (content.trim().length === 0) return
    if (this.status.state === 'running') throw new Error('Harness is still completing the previous turn.')
    await this.start()
    await this.ensureSession()
    this.setStatus('running', 'Harness is working.', this.activeSessionId)
    try {
      await this.applyConfiguredModel()
      await this.call('session.prompt', {
        sessionId: this.activeSessionId,
        mode: 'queue',
        content: modelContent(content, attachments),
      })
    } catch (error) {
      const message = errorMessage(error)
      this.setStatus('error', message, this.activeSessionId)
      this.eventEmitter.fire({ kind: 'error', sessionId: this.activeSessionId, message })
    }
  }

  /** Cancels only the active Host turn; the sidecar remains ready for the next request. */
  async cancelTurn(): Promise<void> {
    if (this.baseUrl === undefined || this.status.state !== 'running') return
    await this.call('session.cancel', { sessionId: this.activeSessionId })
  }

  /** Verifies the configured DeepSeek route without surfacing a probe turn in the chat sidebar. */
  async verifyConnection(): Promise<void> {
    if (this.status.state === 'running') throw new Error('Wait for the current Harness turn to finish before verifying the DeepSeek connection.')
    await this.start()
    const sessionId = randomUUID()
    await this.call('session.create', { sessionId, cwd: this.workspaceFolder() })
    const model = vscode.workspace.getConfiguration('deepseekHarness').get<string>('model', 'deepseek-v4-flash').trim() || 'deepseek-v4-flash'
    await this.call('session.selectModel', { sessionId, provider: 'deepseek-official', model })
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        void this.call('session.cancel', { sessionId }).catch(() => undefined)
        this.settleProbe(new Error('Timed out while waiting for DeepSeek to answer the connection check.'))
      }, 60_000)
      this.probe = { sessionId, output: '', resolve, reject, timeout }
      void this.call('session.prompt', {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: 'Reply with exactly CONNECTION_OK. Do not call any tools.' }],
      }).catch(error => this.settleProbe(error instanceof Error ? error : new Error(String(error))))
    })
  }

  /** Stops the locally owned Host process and both downlink sockets. */
  async stop(): Promise<void> {
    this.stopping = true
    this.settleProbe(new Error('The local Harness Host was stopped before the connection check completed.'))
    this.approvalToolCalls.clear()
    this.toolArguments.clear()
    this.closeSocket(this.mux)
    this.closeSocket(this.host)
    this.mux = undefined
    this.host = undefined
    this.baseUrl = undefined
    const child = this.child
    this.child = undefined
    if (child !== undefined && child.exitCode === null) {
      const exited = onceExit(child)
      child.kill()
      await exited
    }
    this.stopping = false
    this.setStatus('stopped', 'Local Harness Host stopped.', this.activeSessionId)
  }

  /** Builds the complete Host bundle, including the API gateway and web profile assets. */
  async prepare(): Promise<void> {
    const source = await this.requireSource()
    if (this.child !== undefined) throw new Error('Stop the local Harness Host before preparing Harness.')
    this.setStatus('starting', 'Installing and building the local Harness Host…', this.activeSessionId)
    try {
      await enableCorepack(source.root.fsPath)
      await runCommand(corepackCommand(), ['pnpm', 'install', '--frozen-lockfile'], source.root.fsPath)
      await runCommand(corepackCommand(), ['pnpm', 'run', 'build'], source.root.fsPath)
      this.setStatus('stopped', 'Local Harness Host is built and ready.', this.activeSessionId)
    } catch (error) {
      const message = errorMessage(error)
      this.setStatus('error', message, this.activeSessionId)
      throw error
    }
  }

  async listSessions(): Promise<readonly RunnerSessionSummary[]> {
    await this.start()
    const value = record(await this.call('session.list', {}))
    const sessions = array(value?.sessions ?? value?.entries ?? value?.items)
    return sessions.flatMap(raw => {
      const session = record(raw)
      const id = string(session?.sessionId ?? session?.id)
      if (id === undefined) return []
      const projection = record(session?.projection ?? session?.projections)
      const values = record(projection?.values)
      const title = string(session?.title) ?? string(values?.title) ?? string(session?.agentPreset) ?? `Session ${id.slice(0, 8)}`
      const updated = session?.updatedAt ?? session?.updated_at
      return [{ id, title, updatedAt: typeof updated === 'number' ? new Date(updated).toLocaleString() : string(updated) }]
    })
  }

  async resumeSession(id: string): Promise<readonly RunnerHistoryEntry[]> {
    if (this.status.state === 'running') throw new Error('Stop the current Harness turn before opening another session.')
    await this.start()
    const value = record(await this.call('session.history', { sessionId: id, maxMessages: 200 }))
    const entries = array(value?.events ?? value?.items).flatMap(historyEntry)
    this.activeSessionId = id
    this.approvalToolCalls.clear()
    this.toolArguments.clear()
    this.setStatus('ready', 'Restored Harness session.', id)
    return entries
  }

  async inspectCapabilities(): Promise<HarnessCapabilitiesSnapshot> {
    await this.start()
    await this.ensureSession()
    const [providersValue, skills, subagentsValue, presets] = await Promise.all([
      this.call('llm.providers', {}),
      this.listSkills(),
      this.call('subagent.list', { parentSessionId: this.activeSessionId }),
      this.listPresets(),
    ])
    const providers = array(record(providersValue)?.providers).flatMap(item => {
      const recordValue = record(item)
      if (recordValue?.active !== true) return []
      return [string(recordValue?.displayName ?? recordValue?.provider ?? recordValue?.name ?? recordValue?.id)].filter((name): name is string => name !== undefined)
    })
    const subagents = array(record(subagentsValue)?.entries).flatMap(item => {
      const recordValue = record(item)
      const id = string(recordValue?.sessionId ?? recordValue?.id)
      return id === undefined ? [] : [{ id, status: string(recordValue?.activity ?? recordValue?.status ?? recordValue?.reason) }]
    })
    return { providers, skills, subagents, presets }
  }

  async listSkills(): Promise<readonly HarnessSkill[]> {
    await this.start()
    await this.ensureSession()
    const skillsValue = record(await this.call('skill.list', { sessionId: this.activeSessionId }))
    return array(skillsValue?.skills).flatMap(item => {
      const recordValue = record(item)
      const name = string(recordValue?.name)
      return name === undefined ? [] : [{
        name,
        description: string(recordValue?.description),
        modelInvocable: recordValue?.modelInvocable === true,
      }]
    })
  }

  async listPresets(): Promise<readonly HarnessPreset[]> {
    await this.start()
    const presetsValue = record(await this.call('agentPreset.list', {}))
    return array(presetsValue?.presets ?? presetsValue?.entries).flatMap(item => {
      const recordValue = record(item)
      const id = string(recordValue?.id)
      if (id === undefined) return []
      const trust = recordValue?.trust === 'user' ? 'user' : 'system'
      return [{
        id,
        name: string(recordValue?.name) ?? id,
        description: string(recordValue?.description),
        trust,
        isDefault: recordValue?.isDefault === true,
        broken: string(recordValue?.broken),
      }]
    })
  }

  async selectPreset(id: string): Promise<void> {
    if (this.status.state === 'running') throw new Error('Stop the current Harness turn before selecting an agent preset.')
    await this.start()
    await this.ensureSession()
    await this.call('agentPreset.select', { sessionId: this.activeSessionId, agentPreset: id })
  }

  async copyPreset(from: string, id: string, name?: string): Promise<void> {
    await this.start()
    await this.call('agentPreset.copy', { from, agentPreset: id, ...(name === undefined ? {} : { name }) })
  }

  async openPresetDocument(id: string): Promise<void> {
    await this.start()
    const value = record(await this.call('agentPreset.openDocument', { agentPreset: id }))
    if (value?.opened === false) {
      const location = string(value.path)
      if (location !== undefined) await vscode.window.showTextDocument(vscode.Uri.file(location), { preview: false })
    }
  }

  async openHarnessSettings(): Promise<void> {
    const home = vscode.Uri.file(path.join(this.context.globalStorageUri.fsPath, 'host-home'))
    await vscode.workspace.fs.createDirectory(home)
    const file = vscode.Uri.joinPath(home, 'settings.yaml')
    try {
      await vscode.workspace.fs.stat(file)
    } catch {
      await vscode.workspace.fs.writeFile(file, new TextEncoder().encode('# DeepSeek Harness user settings\n'))
    }
    await vscode.window.showTextDocument(file, { preview: false })
  }

  dispose(): void {
    void this.stop()
    this.eventEmitter.dispose()
    this.statusEmitter.dispose()
  }

  private async start(): Promise<void> {
    if (this.baseUrl !== undefined && this.child !== undefined) return
    if (vscode.workspace.getConfiguration('deepseekHarness').get<string>('runnerTransport') === 'remote') {
      throw new Error('Remote Runner is not implemented yet. Select the local Runner in Settings.')
    }
    const source = await this.requireSource()
    const apiKey = await this.apiKey()
    if (apiKey === undefined) throw new Error('Configure a DeepSeek API key before starting the local Harness Host.')
    const entry = path.join(source.root.fsPath, ...CLI_RUNTIME)
    await requireFile(entry, 'The Harness Host is not built yet. Run “DeepSeek Harness: Prepare Local Runtime”.')
    const home = path.join(this.context.globalStorageUri.fsPath, 'host-home')
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(home))
    this.setStatus('starting', 'Starting local Harness Host…', this.activeSessionId)
    const node = vscode.workspace.getConfiguration('deepseekHarness').get<string>('nodePath', 'node').trim() || 'node'
    const child = spawn(node, [entry, 'web', '--port', '0'], {
      cwd: this.workspaceFolder(),
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: apiKey,
        DSH_HOME: home,
        DSH_PERMISSION_MODE: permissionMode(),
      },
      windowsHide: true,
    })
    this.child = child
    let diagnostics = ''
    const ready = new Promise<string>((resolve, reject) => {
      const inspect = (chunk: Buffer): void => {
        const value = String(chunk)
        diagnostics = retainTail(diagnostics, value)
        const match = diagnostics.match(/dsh web:\s*(http:\/\/127\.0\.0\.1:\d+)/)
        if (match?.[1] !== undefined) resolve(match[1])
      }
      child.stdout.on('data', inspect)
      child.stderr.on('data', inspect)
      child.once('error', error => reject(new Error(`Unable to start local Harness Host: ${error.message}`)))
      child.once('exit', code => reject(new Error(`Local Harness Host exited before readiness (code ${String(code)}). ${diagnostics}`)))
    })
    try {
      const baseUrl = await withTimeout(ready, SIDECAR_READY_TIMEOUT_MS, 'Timed out while starting the local Harness Host.')
      this.baseUrl = baseUrl
      await this.call('host.describe', {})
      await this.openDownlinks(baseUrl)
      child.once('exit', (code, signal) => {
        this.child = undefined
        this.baseUrl = undefined
        this.mux = undefined
        this.host = undefined
        if (!this.stopping) {
          this.settleProbe(new Error(`Local Harness Host exited (${signal ?? `code ${String(code)}`}). ${diagnostics}`.trim()))
          const message = `Local Harness Host exited (${signal ?? `code ${String(code)}`}). ${diagnostics}`.trim()
          this.setStatus('error', message, this.activeSessionId)
          this.eventEmitter.fire({ kind: 'error', sessionId: this.activeSessionId, message })
        }
      })
      this.setStatus('ready', 'Local Harness Host is ready.', this.activeSessionId)
    } catch (error) {
      this.child = undefined
      if (child.exitCode === null) child.kill()
      throw error
    }
  }

  private async ensureSession(): Promise<void> {
    try {
      await this.call('session.create', {
        sessionId: this.activeSessionId,
        cwd: this.workspaceFolder(),
      })
    } catch (error) {
      const message = errorMessage(error)
      if (!message.includes('session-conflict')) throw error
    }
  }

  /** Applies the user-selected DeepSeek route through the Host model API. */
  private async applyConfiguredModel(): Promise<void> {
    const model = vscode.workspace.getConfiguration('deepseekHarness').get<string>('model', 'deepseek-v4-flash').trim()
    if (model.length === 0) return
    await this.call('session.selectModel', {
      sessionId: this.activeSessionId,
      provider: 'deepseek-official',
      model,
    })
  }

  private async openDownlinks(baseUrl: string): Promise<void> {
    const url = new URL(baseUrl)
    url.protocol = 'ws:'
    const mux = await openSocket(new URL('/api/events.mux', url).toString())
    const host = await openSocket(new URL('/api/events.host', url).toString())
    mux.on('message', data => { this.handleMuxEnvelope(parseEnvelope(data)) })
    host.on('message', data => { this.handleHostEnvelope(parseEnvelope(data)) })
    mux.on('error', error => this.reportStreamError('mux', error))
    host.on('error', error => this.reportStreamError('host', error))
    this.mux = mux
    this.host = host
  }

  private handleMuxEnvelope(envelope: HostEnvelope | undefined): void {
    const payload = record(envelope?.payload)
    const type = string(payload?.type)
    if (type === undefined) return
    if (type === 'session/event') {
      const sessionId = string(payload?.sessionId)
      const event = record(payload?.event)
      const eventType = string(event?.type)
      const data = record(event?.data)
      if (sessionId !== undefined && eventType !== undefined && data !== undefined && this.probe?.sessionId === sessionId) {
        this.handleProbeEvent(eventType, data)
        return
      }
      if (sessionId === this.activeSessionId && eventType !== undefined && data !== undefined) {
        this.mapSessionEvent(sessionId, eventType, data)
      }
      return
    }
    if (type === 'approval/requested') {
      const sessionId = string(payload?.sessionId)
      const approvalId = string(payload?.approvalId)
      const rpcId = string(envelope?.rpcId)
      if (sessionId === this.activeSessionId && approvalId !== undefined && rpcId !== undefined) {
        const title = string(payload?.toolName) ?? 'Tool'
        const detail = string(payload?.reason) ?? 'Harness requests approval before this tool can continue.'
        const callId = string(payload?.callId) ?? approvalId
        this.approvalToolCalls.set(approvalId, callId)
        this.eventEmitter.fire({ kind: 'approval-request', sessionId, requestId: callId, title, detail })
        void this.answerApproval(rpcId, sessionId, approvalId, title, detail, this.toolArguments.get(callId))
      }
      return
    }
    if (type === 'approval/resolved') {
      const sessionId = string(payload?.sessionId)
      const approvalId = string(payload?.approvalId)
      const outcome = string(payload?.outcome)
      if (sessionId === this.activeSessionId && approvalId !== undefined) {
        const allowed = outcome === 'allowed-once'
        const callId = this.approvalToolCalls.get(approvalId) ?? approvalId
        this.approvalToolCalls.delete(approvalId)
        this.eventEmitter.fire({
          kind: 'tool-result', sessionId, callId,
          summary: allowed ? 'Approved for this run.' : `Approval ${outcome ?? 'resolved'}.`, isError: !allowed,
        })
      }
      return
    }
    if (type === 'question/requested') {
      const sessionId = string(payload?.sessionId)
      const rpcId = string(envelope?.rpcId)
      const questions = array(payload?.questions)
      if (sessionId === this.activeSessionId && rpcId !== undefined) void this.answerQuestions(rpcId, sessionId, questions)
      return
    }
    if (type === 'question/resolved') {
      const sessionId = string(payload?.sessionId)
      const rpcId = string(payload?.questionRpcId)
      const outcome = string(payload?.outcome)
      if (sessionId === this.activeSessionId && rpcId !== undefined) {
        this.eventEmitter.fire({ kind: 'tool-result', sessionId, callId: rpcId, summary: `Question ${outcome ?? 'resolved'}.`, isError: outcome === 'cancelled' })
      }
      return
    }
    if (type === 'stream/error') {
      const error = record(payload?.error)
      this.reportStreamError('mux', new Error(string(error?.message) ?? 'Harness event stream failed.'))
    }
  }

  private handleHostEnvelope(envelope: HostEnvelope | undefined): void {
    const payload = record(envelope?.payload)
    const type = string(payload?.type)
    if (type === 'host/session-status' && string(payload?.sessionId) === this.activeSessionId) {
      const running = payload?.running === true
      this.setStatus(running ? 'running' : 'ready', running ? 'Harness is working.' : 'Harness is ready.', this.activeSessionId)
      return
    }
    if (type === 'host/agent-error' && string(payload?.sessionId) === this.activeSessionId) {
      const message = string(payload?.message) ?? 'Harness agent failed.'
      this.setStatus('error', message, this.activeSessionId)
      this.eventEmitter.fire({ kind: 'error', sessionId: this.activeSessionId, message })
      return
    }
    if (type === 'host/agent-error' && string(payload?.sessionId) === this.probe?.sessionId) {
      this.settleProbe(new Error(string(payload?.message) ?? 'DeepSeek rejected the connection check.'))
      return
    }
    if (type === 'stream/error') {
      const error = record(payload?.error)
      this.reportStreamError('host', new Error(string(error?.message) ?? 'Harness Host stream failed.'))
    }
  }

  private mapSessionEvent(sessionId: string, type: string, data: Record<string, unknown>): void {
    switch (type) {
      case 'turn/start':
        this.setStatus('running', 'Harness is working.', sessionId)
        return
      case 'turn/end':
        this.setStatus('ready', 'Harness is ready.', sessionId)
        return
      case 'assistant/chunk': {
        const chunk = record(data.chunk)
        if (chunk?.type === 'text-delta') {
          const value = string(chunk.text)
          if (value !== undefined) this.eventEmitter.fire({ kind: 'assistant-delta', sessionId, text: value })
        }
        if (chunk?.type === 'reasoning-delta') {
          const value = string(chunk.text)
          if (value !== undefined) this.eventEmitter.fire({ kind: 'reasoning-delta', sessionId, text: value })
        }
        return
      }
      case 'assistant/message': {
        const message = record(data.message)
        const markdown = contentText(message?.content)
        if (markdown.length > 0) this.eventEmitter.fire({ kind: 'assistant-message', sessionId, markdown })
        this.emitUsage(sessionId, data.usage)
        return
      }
      case 'tool/call': {
        const callId = string(data.callId)
        const title = string(data.name)
        if (callId !== undefined && title !== undefined) {
          const argumentsText = string(data.arguments)
          if (argumentsText !== undefined) this.toolArguments.set(callId, argumentsText)
          this.eventEmitter.fire({ kind: 'tool-call', sessionId, callId, title, detail: argumentsText })
        }
        return
      }
      case 'tool/result': {
        const message = record(data.message)
        const source = record(message?.source)
        const callId = string(source?.callId)
        if (callId !== undefined) {
          const summary = contentText(message?.content)
          this.eventEmitter.fire({
            kind: 'tool-result',
            sessionId,
            callId,
            summary: truncate(summary, 4_000),
            isError: data.error !== undefined || toolOutputFailed(summary),
          })
        }
        return
      }
      case 'todo/write': {
        this.eventEmitter.fire({ kind: 'todo', sessionId, todos: todoItems(data.todos) })
        return
      }
      default:
        return
    }
  }

  private handleProbeEvent(type: string, data: Record<string, unknown>): void {
    const probe = this.probe
    if (probe === undefined) return
    if (type === 'assistant/chunk') {
      const chunk = record(data.chunk)
      if (chunk?.type === 'text-delta') probe.output += (string(chunk.text) ?? '')
      return
    }
    if (type === 'assistant/message') {
      probe.output = contentText(record(data.message)?.content)
      return
    }
    if (type === 'turn/end') {
      if (probe.output.trim() === 'CONNECTION_OK') this.settleProbe()
      else this.settleProbe(new Error('DeepSeek returned an unexpected response to the connection check.'))
    }
  }

  private settleProbe(error?: Error): void {
    const probe = this.probe
    if (probe === undefined) return
    this.probe = undefined
    clearTimeout(probe.timeout)
    if (error === undefined) probe.resolve()
    else probe.reject(error)
  }

  private emitUsage(sessionId: string, value: unknown): void {
    const usage = record(value)
    const inputTokens = numeric(usage?.inputTokens)
    const outputTokens = numeric(usage?.outputTokens)
    if (inputTokens !== undefined && outputTokens !== undefined) {
      this.eventEmitter.fire({ kind: 'usage', sessionId, inputTokens, outputTokens })
    }
  }

  private async answerApproval(rpcId: string, sessionId: string, approvalId: string, toolName: string, reason: string, argumentsText: string | undefined): Promise<void> {
    const outcome = await this.review.requestDecision(toolName, argumentsText, reason)
    await this.respond(rpcId, { sessionId, approvalId, outcome })
  }

  private async answerQuestions(rpcId: string, sessionId: string, rawQuestions: readonly unknown[]): Promise<void> {
    const answers: { id: string; selected: string[]; custom?: string }[] = []
    for (const raw of rawQuestions) {
      const question = record(raw)
      const id = string(question?.id)
      const prompt = string(question?.question)
      if (id === undefined || prompt === undefined) continue
      const options = array(question?.options).flatMap(option => {
        const item = record(option)
        const label = string(item?.label)
        return label === undefined ? [] : [{ label, description: string(item?.description) }]
      })
      this.eventEmitter.fire({ kind: 'question-request', sessionId, requestId: rpcId, question: prompt, options: options.map(option => option.label) })
      if (options.length === 0) {
        const custom = await vscode.window.showInputBox({ prompt, placeHolder: string(question?.detail) })
        if (custom === undefined) {
          await this.respondCancelled(rpcId)
          return
        }
        answers.push({ id, selected: [], custom })
        continue
      }
      const selected = await vscode.window.showQuickPick(options, {
        canPickMany: question?.multiSelect === true,
        title: string(question?.header),
        placeHolder: prompt,
      })
      if (selected === undefined) {
        await this.respondCancelled(rpcId)
        return
      }
      answers.push({ id, selected: (Array.isArray(selected) ? selected : [selected]).map(item => item.label) })
    }
    await this.respond(rpcId, { sessionId, answer: { answers } })
  }

  private async respond(rpcId: string, value: unknown): Promise<void> {
    if (this.baseUrl === undefined) return
    await fetch(new URL('/api/respond', this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-response', rpcId, result: { ok: true, value } }),
    })
  }

  private async respondCancelled(rpcId: string): Promise<void> {
    if (this.baseUrl === undefined) return
    await fetch(new URL('/api/respond', this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-response',
        rpcId,
        result: { ok: false, error: { code: 'cancelled', message: 'The user dismissed the VS Code question.', details: {} } },
      }),
    })
  }

  private async call(method: string, payload: Record<string, unknown>): Promise<unknown> {
    const baseUrl = this.baseUrl
    if (baseUrl === undefined) throw new Error('Local Harness Host is not ready.')
    const rpcId = randomUUID()
    const response = await fetch(new URL(`/api/${method}`, baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    })
    if (!response.ok) throw new Error(`Harness Host transport failed for ${method}: HTTP ${String(response.status)}.`)
    const envelope = record(await response.json())
    if (envelope?.type !== 'server-response' || envelope.rpcId !== rpcId) throw new Error(`Harness Host returned an invalid response for ${method}.`)
    const result = record(envelope.result) as RpcResult | undefined
    if (result?.ok !== true) {
      const failure = result?.error
      const code = string(failure?.code)
      const message = string(failure?.message) ?? `Harness Host rejected ${method}.`
      throw new Error(code === undefined ? message : `${code}: ${message}`)
    }
    return result.value
  }

  private reportStreamError(stream: string, error: unknown): void {
    if (this.stopping) return
    const message = `Harness ${stream} event stream failed: ${errorMessage(error)}`
    this.setStatus('error', message, this.activeSessionId)
    this.eventEmitter.fire({ kind: 'error', sessionId: this.activeSessionId, message })
  }

  private closeSocket(socket: WebSocket | undefined): void {
    if (socket !== undefined && socket.readyState === WebSocket.OPEN) socket.close()
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

function modelContent(prompt: string, attachments: readonly PromptAttachment[]): readonly Record<string, unknown>[] {
  const textAttachments = attachments.filter((attachment): attachment is Exclude<PromptAttachment, { kind: 'image' }> => attachment.kind !== 'image')
  const context = textAttachments.map(attachment => [
    `--- ${attachment.label} ---`,
    attachment.content,
    '--- end editor context ---',
  ].join('\n')).join('\n\n')
  const text = context.length === 0 ? prompt : `${prompt}\n\nThe following editor context was explicitly attached by the user:\n${context}`
  return [
    { type: 'text', text },
    ...attachments.filter((attachment): attachment is Extract<PromptAttachment, { kind: 'image' }> => attachment.kind === 'image').map(attachment => ({
      type: 'image', mediaType: attachment.mediaType, data: attachment.data, name: attachment.label,
    })),
  ]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function contentText(value: unknown): string {
  return array(value).flatMap(contentBlockText).join('\n')
}

function contentBlockText(block: unknown): string[] {
  const value = record(block)
  if (value?.type === 'text' && typeof value.text === 'string') return [value.text]
  if (value?.type === 'tool-result') {
    const nested = contentText(value.content)
    return nested.length === 0 ? [] : [nested]
  }
  return []
}

function historyEntry(raw: unknown): RunnerHistoryEntry[] {
  const envelope = record(raw)
  const event = record(envelope?.event ?? raw)
  const type = string(event?.type)
  const data = record(event?.data)
  const message = record(data?.message)
  const text = contentText(message?.content)
  if (text.length === 0) return []
  if (type === 'user/message') return [{ role: 'user', text }]
  if (type === 'assistant/message') return [{ role: 'assistant', text }]
  return []
}

function todoItems(value: unknown): { readonly content: string; readonly status: 'pending' | 'in_progress' | 'completed' }[] {
  const items: { content: string; status: 'pending' | 'in_progress' | 'completed' }[] = []
  for (const raw of array(value)) {
    const item = record(raw)
    const content = string(item?.content)
    const status = string(item?.status)
    if (content === undefined || (status !== 'pending' && status !== 'in_progress' && status !== 'completed')) continue
    items.push({ content, status })
  }
  return items
}

function toolOutputFailed(summary: string): boolean {
  return /\[exit code:\s*[1-9]\d*\]/.test(summary) || summary.startsWith('Error:')
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function retainTail(current: string, next: string): string {
  const combined = `${current}${next}`.trim()
  return combined.length <= 4_000 ? combined : combined.slice(-4_000)
}

function corepackCommand(): string {
  return process.platform === 'win32' ? 'corepack.cmd' : 'corepack'
}

function permissionMode(): 'read-only' | 'workspace-write' | 'danger-full-access' {
  const configured = vscode.workspace.getConfiguration('deepseekHarness').get<string>('permissionMode', 'workspace-write')
  return configured === 'read-only' || configured === 'danger-full-access' ? configured : 'workspace-write'
}

function corepackEnvironment(): NodeJS.ProcessEnv {
  if (process.platform !== 'win32' || process.env.LOCALAPPDATA === undefined) return process.env
  const shim = path.join(process.env.LOCALAPPDATA, 'Programs', 'node-corepack')
  const currentPath = process.env.Path ?? process.env.PATH ?? ''
  return { ...process.env, Path: `${shim}${path.delimiter}${currentPath}` }
}

/** Enables the pnpm shim before a build asks a nested process to invoke pnpm. */
async function enableCorepack(cwd: string): Promise<void> {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA !== undefined) {
    const shim = path.join(process.env.LOCALAPPDATA, 'Programs', 'node-corepack')
    await runCommand(corepackCommand(), ['enable', '--install-directory', shim], cwd)
    return
  }
  await runCommand(corepackCommand(), ['enable'], cwd)
}

function runCommand(command: string, args: readonly string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, env: corepackEnvironment(), stdio: 'pipe', windowsHide: true })
    let diagnostics = ''
    child.stdout.on('data', chunk => { diagnostics = retainTail(diagnostics, String(chunk)) })
    child.stderr.on('data', chunk => { diagnostics = retainTail(diagnostics, String(chunk)) })
    child.once('error', error => reject(new Error(`Unable to run ${command}: ${error.message}`)))
    child.once('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} failed with exit code ${String(code)}.${diagnostics.length === 0 ? '' : ` ${diagnostics}`}`))
    })
  })
}

async function requireFile(file: string, message: string): Promise<void> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(file))
  } catch {
    throw new Error(message)
  }
}

function onceExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise(resolve => { child.once('exit', () => resolve()) })
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(message)) }, timeoutMs)
    void work.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.once('open', () => { resolve(socket) })
    socket.once('error', error => { reject(error) })
  })
}

function parseEnvelope(data: WebSocket.RawData): HostEnvelope | undefined {
  try {
    const value: unknown = JSON.parse(data.toString())
    return record(value)
  } catch {
    return undefined
  }
}

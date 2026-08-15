import * as vscode from 'vscode'
import { unzipSync } from 'fflate'
import type { PromptAttachment, RunnerEvent, RunnerTodoItem } from './runner/protocol'
import type { HarnessRunnerStatus } from './runner/harness-runner'
import type { AgentRunner, RunnerHistoryEntry } from './runner/runner'
import { WorkspaceChangeTracker, type WorkspaceChange } from './workspace-changes'

type ChatRole = 'assistant' | 'user' | 'thinking' | 'tool' | 'error'

interface ChatMessage {
  readonly id: string
  readonly role: ChatRole
  text: string
  readonly title?: string
  readonly callId?: string
  state?: 'running' | 'ok' | 'error'
}

interface Usage {
  readonly inputTokens: number
  readonly outputTokens: number
}

interface StoredAttachment {
  readonly id: string
  readonly attachment: PromptAttachment
}

interface WebviewRequest {
  readonly type?: unknown
  readonly content?: unknown
}

interface ArchiveRequest {
  readonly before?: unknown
  readonly after?: unknown
  readonly label?: unknown
}

interface DroppedAttachment {
  readonly name: string
  readonly mediaType?: string
  readonly data: string
}

/**
 * Independent sidebar chat with the same presentation grammar as Harness Web:
 * a resident composer, Think disclosures, durable todo list, and tool rows.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly disposables: vscode.Disposable[]
  private readonly messages: ChatMessage[] = []
  private readonly attachments: StoredAttachment[] = []
  private todos: readonly RunnerTodoItem[] = []
  private workspaceChanges: readonly WorkspaceChange[] = []
  private usage: Usage | undefined
  private view: vscode.WebviewView | undefined
  private nextId = 1
  private trackingTurn: 'idle' | 'arming' | 'running' | 'finishing' = 'idle'

  constructor(
    private readonly runner: AgentRunner,
    private readonly configureApiKey: () => Promise<boolean>,
    private readonly apiKeyConfigured: () => Promise<boolean>,
    private readonly model: () => string,
    private readonly setModel: (model: string) => Promise<void>,
    private readonly permissionMode: () => 'read-only' | 'workspace-write' | 'danger-full-access',
    private readonly setPermissionMode: (mode: 'read-only' | 'workspace-write' | 'danger-full-access') => Promise<void>,
    private readonly versionSnapshots: () => boolean,
    private readonly toggleVersionSnapshots: () => Promise<boolean>,
    private readonly changeTracker: WorkspaceChangeTracker,
  ) {
    this.disposables = [
      runner.onDidEvent(event => this.handleRunnerEvent(event)),
      runner.onDidChangeStatus(status => this.handleRunnerStatus(status)),
      changeTracker.onDidChange(changes => {
        this.workspaceChanges = changes
        this.post({ type: 'workspaceChanges', changes: this.workspaceChanges })
      }),
    ]
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true }
    view.webview.html = html(view.webview)
    this.disposables.push(view.webview.onDidReceiveMessage(message => {
      void this.handleWebviewRequest(message)
    }))
    this.disposables.push(view.onDidDispose(() => { this.view = undefined }))
    void this.refresh()
  }

  async focus(): Promise<void> {
    await vscode.commands.executeCommand('deepseekHarness.chat.focus')
  }

  newSession(): void {
    try {
      this.runner.newSession()
      this.changeTracker.cancel()
      this.trackingTurn = 'idle'
      this.messages.splice(0)
      this.attachments.splice(0)
      this.todos = []
      this.workspaceChanges = []
      this.usage = undefined
      this.nextId = 1
      void this.refresh()
    } catch (error) {
      this.addError(errorMessage(error))
    }
  }

  /** Starts a normal Harness turn that explicitly asks for a named skill. */
  async invokeSkill(name: string, description?: string): Promise<void> {
    await this.focus()
    const task = await vscode.window.showInputBox({
      title: `Run Harness skill: ${name}`,
      prompt: description === undefined ? 'Describe the task for this skill.' : description,
      placeHolder: 'What should this skill do?',
      ignoreFocusOut: true,
    })
    if (task === undefined || task.trim().length === 0) return
    await this.submit(`Use the Harness skill "${name}" for this task.\n\n${task.trim()}`)
  }

  /** Creates a blank session before the Host selects a user-chosen preset. */
  async startWithPreset(id: string, name: string): Promise<void> {
    if (this.runner.getStatus().state === 'running') throw new Error('Stop the current Harness turn before selecting an agent preset.')
    this.newSession()
    await this.runner.selectPreset(id)
    await this.focus()
    this.post({ type: 'notice', text: `New session is using agent preset: ${name}.` })
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose()
  }

  private async handleWebviewRequest(message: unknown): Promise<void> {
    const request = asRequest(message)
    if (request === undefined) return
    switch (request.type) {
      case 'prompt':
        if (typeof request.content === 'string') await this.submit(request.content)
        return
      case 'addContext':
        if (isContextKind(request.content)) await this.addContext(request.content)
        return
      case 'pickContext':
      case 'attachSelection':
        await this.addContext('selection')
        return
      case 'sessionHistory':
        await this.openSessionHistory()
        return
      case 'droppedFiles':
        await this.attachDroppedFiles(request.content)
        return
      case 'removeAttachment':
        if (typeof request.content === 'string') this.removeAttachment(request.content)
        return
      case 'openChangedFile':
        if (typeof request.content === 'string') await this.changeTracker.openChange(request.content)
        return
      case 'undoChangedFile':
        if (typeof request.content === 'string') {
          try {
            await this.changeTracker.undoChange(request.content)
            this.post({ type: 'notice', text: '已撤销该文件的本轮 Harness 修改。' })
          } catch (error) {
            this.addError(errorMessage(error))
          }
        }
        return
      case 'openArchive': {
        const archive = asArchiveRequest(request.content)
        if (archive !== undefined) await this.changeTracker.openArchive(archive.before, archive.after, archive.label)
        return
      }
      case 'toggleVersionSnapshots':
        await this.toggleVersionSnapshots()
        await this.refresh()
        return
      case 'setModel':
        if (isSupportedModel(request.content)) {
          await this.setModel(request.content)
          await this.refresh()
        }
        return
      case 'setPermissionMode':
        if (isPermissionMode(request.content)) {
          await this.setPermissionMode(request.content)
          await this.refresh()
        }
        return
      case 'newSession':
        this.newSession()
        return
      case 'stopRunner':
        await this.stopRunner()
        return
      case 'configureApiKey':
        await this.configureKey()
        return
      default:
        return
    }
  }

  private async submit(content: string): Promise<void> {
    const prompt = content.trim()
    if (prompt.length === 0) return
    this.workspaceChanges = []
    this.trackingTurn = 'arming'
    await this.changeTracker.begin()
    this.addMessage('user', prompt)
    const attachments = this.attachments.map(item => item.attachment)
    this.attachments.splice(0)
    this.post({ type: 'clearAttachments' })
    try {
      await this.runner.prompt(prompt, attachments)
    } catch (error) {
      this.trackingTurn = 'idle'
      this.changeTracker.cancel()
      this.addError(errorMessage(error))
    }
  }

  private async addContext(kind: 'selection' | 'document' | 'diagnostics' | 'external' | 'folder'): Promise<void> {
    if (kind === 'external') {
      await this.attachExternalFiles()
      return
    }
    if (kind === 'folder') {
      await this.attachExternalFolder()
      return
    }
    if (kind === 'diagnostics') {
      this.attachDiagnostics()
      return
    }
    this.attachEditorContext(kind)
  }

  private attachEditorContext(kind: 'selection' | 'document'): void {
    const editor = vscode.window.activeTextEditor
    if (editor === undefined) {
      this.addError('Open an editor before attaching context.')
      return
    }
    const selection = editor.selection
    const selected = editor.document.getText(selection)
    if (kind === 'selection' && selected.length === 0) {
      this.addError('Select text in the editor before attaching a selection.')
      return
    }
    const content = kind === 'selection' ? selected : editor.document.getText()
    if (content.trim().length === 0) {
      this.addError('The requested editor context is empty.')
      return
    }
    const maximum = 20_000
    const attachment: PromptAttachment = {
      kind,
      uri: editor.document.uri.toString(),
      label: kind === 'document' ? editor.document.fileName : `${editor.document.fileName}:${editor.selection.start.line + 1}`,
      content: content.length <= maximum ? content : `${content.slice(0, maximum - 1)}…`,
    }
    this.storeAttachment(attachment)
  }

  private attachDiagnostics(): void {
    const editor = vscode.window.activeTextEditor
    if (editor === undefined) {
      this.addError('Open an editor before attaching diagnostics.')
      return
    }
    const diagnostics = vscode.languages.getDiagnostics(editor.document.uri)
    if (diagnostics.length === 0) {
      this.addError('The active file has no diagnostics to attach.')
      return
    }
    const content = diagnostics.slice(0, 100).map(diagnostic => {
      const position = diagnostic.range.start
      return `${position.line + 1}:${position.character + 1} ${diagnostic.message}`
    }).join('\n')
    this.storeAttachment({
      kind: 'diagnostic',
      uri: editor.document.uri.toString(),
      label: `Problems: ${editor.document.fileName}`,
      content,
    })
  }

  private async attachExternalFiles(): Promise<void> {
    const files = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      title: 'Attach files from another folder',
      openLabel: 'Attach to Harness request',
    })
    if (files === undefined || files.length === 0) return
    let attached = 0
    for (const file of files) {
      try {
        if (await this.attachFile(file, 'External')) attached += 1
      } catch (error) {
        this.addError(`Unable to attach ${file.fsPath}: ${errorMessage(error)}`)
      }
    }
    if (attached > 0) this.post({ type: 'notice', text: `Attached ${String(attached)} external file(s).` })
  }

  private async attachExternalFolder(): Promise<void> {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      title: 'Attach a folder',
      openLabel: 'Attach folder contents',
    })
    const root = selected?.[0]
    if (root === undefined) return
    const files = await collectFiles(root, 30)
    let attached = 0
    for (const file of files) if (await this.attachFile(file, 'Folder')) attached += 1
    this.post({ type: 'notice', text: `Attached ${String(attached)} file(s) from ${root.fsPath}.` })
  }

  private async attachFile(file: vscode.Uri, prefix: string): Promise<boolean> {
    const bytes = await vscode.workspace.fs.readFile(file)
    if (bytes.byteLength > 5_000_000) {
      this.addError(`Skipped file over 5 MB: ${file.fsPath}`)
      return false
    }
    if (file.path.toLowerCase().endsWith('.zip')) return this.attachZip(bytes, file.fsPath, prefix)
    const mediaType = imageMediaType(file)
    if (mediaType !== undefined) {
      this.storeAttachment({
        kind: 'image', uri: file.toString(), label: `${prefix}: ${file.fsPath}`,
        mediaType, data: Buffer.from(bytes).toString('base64'),
      })
      return true
    }
    if (bytes.includes(0)) {
      this.addError(`Skipped binary file: ${file.fsPath}`)
      return false
    }
    const content = new TextDecoder().decode(bytes)
    if (content.trim().length === 0) {
      this.addError(`Skipped empty file: ${file.fsPath}`)
      return false
    }
    const maximum = 20_000
    this.storeAttachment({
      kind: 'document', uri: file.toString(), label: `${prefix}: ${file.fsPath}`,
      content: content.length <= maximum ? content : `${content.slice(0, maximum - 1)}…`,
    })
    return true
  }

  private attachZip(bytes: Uint8Array, label: string, prefix: string): boolean {
    let entries: Record<string, Uint8Array>
    try {
      entries = unzipSync(bytes)
    } catch {
      this.addError(`Unable to read ZIP attachment: ${label}`)
      return false
    }
    let attached = 0
    let total = 0
    for (const [name, entry] of Object.entries(entries)) {
      if (attached >= 30 || total + entry.byteLength > 20_000_000 || entry.byteLength > 5_000_000) continue
      total += entry.byteLength
      const mediaType = imageMediaTypePath(name)
      if (mediaType !== undefined) {
        this.storeAttachment({ kind: 'image', label: `${prefix} ZIP: ${label}/${name}`, mediaType, data: Buffer.from(entry).toString('base64') })
        attached += 1
        continue
      }
      if (entry.includes(0)) continue
      const content = new TextDecoder().decode(entry)
      if (content.trim().length === 0) continue
      this.storeAttachment({ kind: 'document', label: `${prefix} ZIP: ${label}/${name}`, content: content.length <= 20_000 ? content : `${content.slice(0, 19_999)}…` })
      attached += 1
    }
    if (attached === 0) this.addError(`ZIP contains no attachable text or image: ${label}`)
    return attached > 0
  }

  private async attachDroppedFiles(value: unknown): Promise<void> {
    if (!Array.isArray(value)) return
    let attached = 0
    for (const raw of value.slice(0, 8)) {
      const file = droppedAttachment(raw)
      if (file === undefined) continue
      const bytes = Buffer.from(file.data, 'base64')
      if (bytes.byteLength > 5_000_000) {
        this.addError(`Skipped dropped file over 5 MB: ${file.name}`)
        continue
      }
      if (file.name.toLowerCase().endsWith('.zip')) {
        if (this.attachZip(bytes, file.name, 'Dropped')) attached += 1
        continue
      }
      const mediaType = supportedDroppedImage(file.mediaType)
      if (mediaType !== undefined) {
        this.storeAttachment({ kind: 'image', label: `Dropped: ${file.name}`, mediaType, data: file.data })
        attached += 1
        continue
      }
      if (bytes.includes(0)) {
        this.addError(`Skipped binary dropped file: ${file.name}`)
        continue
      }
      const content = new TextDecoder().decode(bytes)
      if (content.trim().length === 0) continue
      this.storeAttachment({ kind: 'document', label: `Dropped: ${file.name}`, content: content.length <= 20_000 ? content : `${content.slice(0, 19_999)}…` })
      attached += 1
    }
    if (attached > 0) this.post({ type: 'notice', text: `Attached ${String(attached)} dropped file(s).` })
  }

  private storeAttachment(attachment: PromptAttachment): void {
    const stored: StoredAttachment = { id: randomNonce(), attachment }
    this.attachments.push(stored)
    this.post({ type: 'attachments', attachments: this.attachments.map(attachmentView) })
  }

  private removeAttachment(id: string): void {
    const index = this.attachments.findIndex(item => item.id === id)
    if (index === -1) return
    this.attachments.splice(index, 1)
    this.post({ type: 'attachments', attachments: this.attachments.map(attachmentView) })
  }

  private async stopRunner(): Promise<void> {
    try {
      await this.runner.cancelTurn()
    } catch (error) {
      this.addError(errorMessage(error))
    }
  }

  private async openSessionHistory(): Promise<void> {
    try {
      const sessions = await this.runner.listSessions()
      if (sessions.length === 0) {
        this.post({ type: 'notice', text: 'No saved Harness sessions yet.' })
        return
      }
      const picked = await vscode.window.showQuickPick(sessions.map(session => ({
        label: session.title,
        description: session.updatedAt,
        detail: session.id,
        session,
      })), { title: 'DeepSeek Harness sessions', placeHolder: 'Restore a previous conversation' })
      if (picked === undefined) return
      const entries = await this.runner.resumeSession(picked.session.id)
      this.restoreHistory(entries)
    } catch (error) {
      this.addError(errorMessage(error))
    }
  }

  private restoreHistory(entries: readonly RunnerHistoryEntry[]): void {
    this.changeTracker.cancel()
    this.trackingTurn = 'idle'
    this.messages.splice(0)
    this.attachments.splice(0)
    this.todos = []
    this.workspaceChanges = []
    this.usage = undefined
    this.nextId = 1
    for (const entry of entries) this.addMessage(entry.role, entry.text, undefined, undefined, 'ok')
    void this.refresh()
  }

  private async configureKey(): Promise<void> {
    const configured = await this.configureApiKey()
    if (configured) this.post({ type: 'notice', text: 'API 密钥已保存到 VS Code SecretStorage。' })
    await this.refresh()
  }

  private handleRunnerEvent(event: RunnerEvent): void {
    switch (event.kind) {
      case 'assistant-delta':
        this.appendAssistantDelta(event.text)
        return
      case 'reasoning-delta':
        this.appendReasoningDelta(event.text)
        return
      case 'assistant-message':
        this.commitAssistantMessage(event.markdown)
        this.finishThinking()
        return
      case 'usage':
        this.usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens }
        this.post({ type: 'usage', usage: this.usage })
        return
      case 'todo':
        this.todos = event.todos
        this.post({ type: 'todos', todos: this.todos })
        return
      case 'tool-call':
        this.changeTracker.captureToolTarget(event.title, event.detail)
        this.addMessage('tool', event.detail === undefined ? '' : event.detail, event.title, event.callId, 'running')
        return
      case 'tool-result':
        this.completeTool(event.callId, event.summary || '无输出。', event.isError)
        return
      case 'status':
        return
      case 'approval-request':
        this.addMessage('tool', event.detail, `Approval · ${event.title}`, event.requestId, 'running')
        return
      case 'question-request':
        this.addMessage('tool', event.question, 'Question', event.requestId, 'running')
        return
      case 'file-proposal':
        this.addMessage('tool', 'Open the approval preview to inspect the proposed file change before allowing it.', 'File change review', event.proposalId, 'running')
        return
      case 'error':
        this.addError(event.message)
        return
      default:
        assertNever(event)
    }
  }

  private appendAssistantDelta(delta: string): void {
    const previous = this.messages.at(-1)
    if (previous?.role === 'assistant') {
      previous.text += delta
      this.post({ type: 'replaceMessage', message: previous })
      return
    }
    this.addMessage('assistant', delta, undefined, undefined, 'running')
  }

  private appendReasoningDelta(delta: string): void {
    const previous = this.messages.at(-1)
    if (previous?.role === 'thinking' && previous.state === 'running') {
      previous.text += delta
      this.post({ type: 'replaceMessage', message: previous })
      return
    }
    this.addMessage('thinking', delta, 'Think', undefined, 'running')
  }

  private commitAssistantMessage(markdown: string): void {
    const previous = this.messages.at(-1)
    if (previous?.role === 'assistant') {
      previous.text = markdown
      previous.state = 'ok'
      this.post({ type: 'replaceMessage', message: previous })
      return
    }
    this.addMessage('assistant', markdown, undefined, undefined, 'ok')
  }

  private finishThinking(): void {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index]
      if (message?.role !== 'thinking') continue
      if (message.state === 'running') {
        message.state = 'ok'
        this.post({ type: 'replaceMessage', message })
      }
      return
    }
  }

  private completeTool(callId: string, summary: string, isError: boolean): void {
    let message: ChatMessage | undefined
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const candidate = this.messages[index]
      if (candidate?.role === 'tool' && candidate.callId === callId) {
        message = candidate
        break
      }
    }
    if (message !== undefined) {
      message.text = summary
      message.state = isError ? 'error' : 'ok'
      this.post({ type: 'replaceMessage', message })
      return
    }
    this.addMessage('tool', summary, isError ? 'Tool failed' : 'Tool result', callId, isError ? 'error' : 'ok')
  }

  private addError(message: string): void {
    this.addMessage('error', message, 'DeepSeek Harness')
  }

  private addMessage(
    role: ChatRole,
    text: string,
    title?: string,
    callId?: string,
    state?: ChatMessage['state'],
  ): void {
    const message: ChatMessage = {
      id: String(this.nextId++), role, text,
      ...(title === undefined ? {} : { title }),
      ...(callId === undefined ? {} : { callId }),
      ...(state === undefined ? {} : { state }),
    }
    this.messages.push(message)
    this.post({ type: 'message', message })
  }

  private async refresh(): Promise<void> {
    const apiKeyConfigured = await this.apiKeyConfigured()
    this.post({
      type: 'snapshot',
      messages: this.messages,
      attachments: this.attachments.map(attachmentView),
      workspaceChanges: this.workspaceChanges,
      todos: this.todos,
      usage: this.usage,
      model: this.model(),
      permissionMode: this.permissionMode(),
      versionSnapshots: this.versionSnapshots(),
      status: this.runner.getStatus(),
      apiKeyConfigured,
    })
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message)
  }

  private handleRunnerStatus(status: HarnessRunnerStatus): void {
    this.post({ type: 'status', status })
    if (status.state === 'running' && this.trackingTurn === 'arming') this.trackingTurn = 'running'
    const ended = status.state === 'ready' || status.state === 'error' || status.state === 'stopped'
    if (!ended || this.trackingTurn === 'idle' || this.trackingTurn === 'finishing') return
    if (this.trackingTurn === 'arming' && status.state === 'ready') return
    this.trackingTurn = 'finishing'
    void this.finishWorkspaceTracking()
  }

  private async finishWorkspaceTracking(): Promise<void> {
    try {
      this.workspaceChanges = await this.changeTracker.finish(this.versionSnapshots())
      this.post({ type: 'workspaceChanges', changes: this.workspaceChanges })
    } catch (error) {
      this.addError(`Unable to collect workspace changes: ${errorMessage(error)}`)
    } finally {
      this.trackingTurn = 'idle'
    }
  }
}

function asRequest(value: unknown): WebviewRequest | undefined {
  return value !== null && typeof value === 'object' ? value as WebviewRequest : undefined
}

function asArchiveRequest(value: unknown): { readonly before?: string; readonly after?: string; readonly label: string } | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const archive = value as ArchiveRequest
  const before = typeof archive.before === 'string' ? archive.before : undefined
  const after = typeof archive.after === 'string' ? archive.after : undefined
  const label = typeof archive.label === 'string' ? archive.label : 'version archive'
  return { ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }), label }
}

function isSupportedModel(value: unknown): value is 'deepseek-v4-pro' | 'deepseek-v4-flash' {
  return value === 'deepseek-v4-pro' || value === 'deepseek-v4-flash'
}

function isPermissionMode(value: unknown): value is 'read-only' | 'workspace-write' | 'danger-full-access' {
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access'
}

function isContextKind(value: unknown): value is 'selection' | 'document' | 'diagnostics' | 'external' | 'folder' {
  return value === 'selection' || value === 'document' || value === 'diagnostics' || value === 'external' || value === 'folder'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function attachmentView(stored: StoredAttachment): { readonly id: string; readonly label: string; readonly kind: PromptAttachment['kind'] } {
  return { id: stored.id, label: stored.attachment.label, kind: stored.attachment.kind }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported Runner event: ${JSON.stringify(value)}`)
}

function imageMediaType(uri: vscode.Uri): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | undefined {
  return imageMediaTypePath(uri.path)
}

function imageMediaTypePath(value: string): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | undefined {
  switch (value.toLowerCase().match(/\.(png|jpe?g|webp|gif)$/)?.[1]) {
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'webp': return 'image/webp'
    case 'gif': return 'image/gif'
    default: return undefined
  }
}

async function collectFiles(root: vscode.Uri, maximum: number): Promise<vscode.Uri[]> {
  const found: vscode.Uri[] = []
  const visit = async (folder: vscode.Uri): Promise<void> => {
    for (const [name, kind] of await vscode.workspace.fs.readDirectory(folder)) {
      if (found.length >= maximum) return
      const uri = vscode.Uri.joinPath(folder, name)
      if (kind === vscode.FileType.Directory) await visit(uri)
      else if (kind === vscode.FileType.File) found.push(uri)
    }
  }
  await visit(root)
  return found
}

function droppedAttachment(value: unknown): DroppedAttachment | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  return typeof record.name === 'string' && typeof record.data === 'string'
    ? { name: record.name, ...(typeof record.mediaType === 'string' ? { mediaType: record.mediaType } : {}), data: record.data }
    : undefined
}

function supportedDroppedImage(value: string | undefined): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | undefined {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif' ? value : undefined
}

function html(webview: vscode.Webview): string {
  const nonce = randomNonce()
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DeepSeek Harness</title>
  <style>
    :root { color: var(--vscode-foreground); font-family: var(--vscode-font-family); --panel: var(--vscode-sideBar-background); --card: var(--vscode-editor-background); --line: var(--vscode-widget-border, var(--vscode-sideBar-border, transparent)); --muted: var(--vscode-descriptionForeground); --soft: var(--vscode-editorWidget-background, var(--vscode-textBlockQuote-background)); --accent: var(--vscode-focusBorder); }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body { margin: 0; overflow: hidden; background: var(--panel); font-size: 13px; line-height: 1.5; }
    button { border: 0; color: inherit; background: transparent; font: inherit; cursor: pointer; }
    button:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    #app { height: 100%; min-height: 0; display: flex; flex-direction: column; }
    .topbar { height: 48px; display: flex; align-items: center; gap: 8px; padding: 0 10px 0 12px; border-bottom: 1px solid var(--line); }
    .brand-mark { width: 23px; height: 23px; display: grid; place-items: center; border-radius: 7px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font-size: 14px; font-weight: 700; }
    .topbar[data-running="true"] .brand-mark { animation: active-glow 1.15s ease-in-out infinite; }
    .topbar[data-running="true"] .brand::after { content: "正在工作"; margin-left: 7px; color: var(--vscode-progressBar-background); font-size: 10px; font-weight: 400; letter-spacing: 0; }
    .brand { min-width: 0; flex: 1; font-weight: 600; letter-spacing: .1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .icon-button { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 6px; color: var(--muted); font-size: 16px; }
    .icon-button:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    .session-line { display: flex; align-items: center; gap: 6px; margin: 10px 16px 0; color: var(--muted); font-size: 11px; }
    .state-dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--vscode-descriptionForeground); }
    .state-dot[data-state="ready"] { background: var(--vscode-testing-iconPassed); }
    .state-dot[data-state="running"], .state-dot[data-state="starting"] { background: var(--vscode-progressBar-background); animation: pulse 1.4s ease-in-out infinite; }
    .state-dot[data-state="error"] { background: var(--vscode-testing-iconFailed); }
    @keyframes pulse { 50% { opacity: .35; } }
    @keyframes active-glow { 50% { transform: scale(1.07); box-shadow: 0 0 0 4px color-mix(in srgb, var(--vscode-progressBar-background) 22%, transparent), 0 0 14px color-mix(in srgb, var(--vscode-progressBar-background) 62%, transparent); } }
    #todo-dock { margin: 10px 12px 0; border: 1px solid var(--line); border-radius: 8px; background: var(--soft); }
    #todo-dock summary { display: flex; align-items: center; gap: 7px; min-height: 34px; padding: 6px 9px; color: var(--muted); cursor: pointer; list-style: none; }
    #todo-dock summary::-webkit-details-marker { display: none; }
    .todo-count { margin-left: auto; padding: 0 6px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 11px; }
    #todos { display: flex; flex-direction: column; gap: 7px; padding: 0 10px 10px; }
    .todo { display: flex; align-items: flex-start; gap: 8px; color: var(--muted); font-size: 12px; }
    .todo-symbol { width: 14px; flex: none; text-align: center; color: var(--vscode-descriptionForeground); }
    .todo[data-status="in_progress"] .todo-symbol { color: var(--vscode-progressBar-background); }
    .todo[data-status="completed"] { text-decoration: line-through; opacity: .7; }
    #conversation { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 10px; padding: 14px 12px 8px; overflow-y: auto; overflow-wrap: anywhere; }
    #empty { flex: 1; min-height: 0; display: grid; place-items: center; padding: 26px 20px; text-align: center; color: var(--muted); }
    #empty[hidden] { display: none !important; }
    .empty-logo { width: 42px; height: 42px; display: grid; place-items: center; margin-bottom: 13px; border: 1px solid var(--line); border-radius: 13px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font-size: 22px; }
    .empty-title { color: var(--vscode-foreground); font-size: 15px; font-weight: 600; }
    .empty-copy { max-width: 260px; margin-top: 5px; font-size: 12px; }
    .message { width: 100%; }
    .user { align-self: flex-end; width: fit-content; max-width: 92%; padding: 8px 11px; border-radius: 10px 3px 10px 10px; background: var(--vscode-textBlockQuote-background); color: var(--vscode-foreground); white-space: pre-wrap; }
    .assistant { padding: 1px 2px; color: var(--vscode-foreground); font-size: 13px; line-height: 1.7; }
    .assistant .plain { margin: 0 0 9px; white-space: pre-wrap; }
    .assistant .md-heading { margin: 16px 0 7px; color: var(--vscode-foreground); font-weight: 650; line-height: 1.3; }
    .assistant h1.md-heading { font-size: 20px; } .assistant h2.md-heading { font-size: 16px; } .assistant h3.md-heading { font-size: 14px; }
    .assistant ul, .assistant ol { margin: 4px 0 11px; padding-left: 22px; } .assistant li { margin: 3px 0; padding-left: 2px; }
    .assistant blockquote { margin: 8px 0; padding: 4px 10px; border-left: 3px solid var(--vscode-textBlockQuote-border); color: var(--muted); background: var(--vscode-textBlockQuote-background); }
    .assistant strong { color: var(--vscode-foreground); font-weight: 650; } .assistant code { padding: 1px 4px; border-radius: 4px; color: var(--vscode-textPreformat-foreground); background: var(--vscode-textPreformat-background); font: 12px var(--vscode-editor-font-family); }
    .table-wrap { overflow-x: auto; margin: 10px 0 13px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); } .markdown-table { width: max-content; min-width: 100%; border-collapse: collapse; font-size: 12px; line-height: 1.45; } .markdown-table th { padding: 8px 10px; color: var(--vscode-foreground); background: var(--soft); font-weight: 600; text-align: left; white-space: nowrap; } .markdown-table td { padding: 7px 10px; border-top: 1px solid var(--line); color: var(--vscode-foreground); vertical-align: top; } .markdown-table tr:hover td { background: var(--vscode-list-hoverBackground); }
    .assistant pre { overflow: auto; margin: 9px 0; padding: 9px 10px; border-radius: 7px; background: var(--vscode-textCodeBlock-background); color: var(--vscode-editor-foreground); font: 12px/1.5 var(--vscode-editor-font-family); white-space: pre; }
    .think { position: relative; border-radius: 6px; color: var(--muted); overflow: hidden; }
    .think[data-state="running"]::after { content: ""; position: absolute; inset: 0 auto 0 0; width: 170px; pointer-events: none; background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--panel) 55%, transparent), transparent); animation: sweep 2.6s ease-out infinite; }
    @keyframes sweep { from { left: -170px; } to { left: 100%; } }
    .think summary, .tool summary { display: flex; align-items: center; min-height: 29px; gap: 7px; cursor: pointer; list-style: none; }
    .think summary::-webkit-details-marker, .tool summary::-webkit-details-marker { display: none; }
    .disclosure { width: 14px; color: var(--muted); font-size: 11px; transition: transform .12s ease; }
    details[open] > summary .disclosure { transform: rotate(90deg); }
    .think-icon, .tool-icon { width: 16px; flex: none; text-align: center; color: var(--muted); }
    .think-title { color: var(--vscode-foreground); font-weight: 400; }
    .row-separator { width: 2px; height: 2px; border-radius: 50%; background: var(--muted); }
    .row-summary { overflow: hidden; flex: 1; color: var(--muted); text-overflow: ellipsis; white-space: nowrap; }
    .think-body { padding: 4px 4px 7px 37px; color: var(--muted); font-size: 12px; line-height: 1.6; white-space: pre-wrap; }
    .tool { border: 1px solid var(--line); border-radius: 7px; background: var(--card); }
    .tool summary { padding: 5px 8px; }
    .tool[data-state="error"] { border-color: var(--vscode-inputValidation-errorBorder); }
    .tool-icon { color: var(--vscode-focusBorder); }
    .tool-title { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-foreground); }
    .tool-state { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--vscode-testing-iconPassed); }
    .tool[data-state="running"] .tool-state { background: var(--vscode-progressBar-background); animation: pulse 1.4s ease-in-out infinite; }
    .tool[data-state="error"] .tool-state { background: var(--vscode-testing-iconFailed); }
    .tool-output { max-height: 260px; overflow: auto; margin: 0; padding: 8px 10px 10px 36px; border-top: 1px solid var(--line); color: var(--muted); background: var(--vscode-textCodeBlock-background); font: 11px/1.5 var(--vscode-editor-font-family); white-space: pre-wrap; }
    .error { padding: 8px 10px; border: 1px solid var(--vscode-inputValidation-errorBorder); border-radius: 7px; color: var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground); white-space: pre-wrap; }
    .error-title { margin-bottom: 3px; font-size: 11px; font-weight: 600; }
    #changes-dock { flex: none; margin: 6px 12px 0; border: 1px solid var(--line); border-radius: 8px; background: var(--soft); }
    #changes-dock summary { display: flex; align-items: center; gap: 7px; min-height: 34px; padding: 6px 9px; color: var(--vscode-foreground); cursor: pointer; list-style: none; }
    #changes-dock summary::-webkit-details-marker { display: none; }
    #changes-count { margin-left: auto; padding: 0 6px; border-radius: 8px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); font-size: 11px; }
    #changes { display: flex; flex-direction: column; max-height: 160px; overflow-y: auto; border-top: 1px solid var(--line); }
    .change-row { display: flex; min-width: 0; align-items: center; gap: 7px; padding: 6px 8px; border-bottom: 1px solid color-mix(in srgb, var(--line) 65%, transparent); color: var(--muted); font-size: 11px; }
    .change-row:last-child { border-bottom: 0; } .change-kind { width: 16px; color: var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-focusBorder)); text-align: center; font-weight: 700; } .change-kind[data-kind="created"] { color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-testing-iconPassed)); } .change-kind[data-kind="deleted"] { color: var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-testing-iconFailed)); }
    .change-open { min-width: 0; flex: 1; overflow: hidden; color: var(--vscode-textLink-foreground); text-align: left; text-overflow: ellipsis; white-space: nowrap; } .change-open:hover { text-decoration: underline; } .change-stats { flex: none; display: inline-flex; gap: 4px; padding: 2px 5px; border: 1px solid var(--line); border-radius: 4px; color: var(--muted); font-size: 10px; } .change-stats:hover { background: var(--vscode-toolbar-hoverBackground); } .added { color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-testing-iconPassed)); } .removed { color: var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-testing-iconFailed)); } .undo-change, .archive-open { flex: none; padding: 2px 5px; border: 1px solid var(--line); border-radius: 4px; color: var(--muted); font-size: 10px; } .undo-change:hover { color: var(--vscode-errorForeground); border-color: var(--vscode-inputValidation-errorBorder); background: var(--vscode-inputValidation-errorBackground); } .archive-open:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    #composer-seat { position: sticky; bottom: 0; padding: 10px 12px 12px; border-top: 1px solid var(--line); background: var(--panel); }
    #stats { min-height: 19px; padding: 0 6px 5px; color: var(--muted); font-size: 11px; text-align: center; text-overflow: ellipsis; white-space: nowrap; overflow: hidden; }
    #attachments { display: flex; flex-wrap: wrap; gap: 5px; margin: 0 0 7px; }
    .attachment { display: inline-flex; max-width: 100%; align-items: center; gap: 5px; padding: 3px 4px 3px 8px; border: 1px solid var(--line); border-radius: 12px; color: var(--vscode-foreground); background: var(--soft); font-size: 11px; overflow: hidden; white-space: nowrap; } .attachment-label { overflow: hidden; text-overflow: ellipsis; } .attachment-remove { width: 17px; height: 17px; display: grid; place-items: center; border-radius: 50%; color: var(--muted); font-size: 13px; } .attachment-remove:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    .composer { border: 1px solid var(--line); border-radius: 10px; background: var(--vscode-input-background); box-shadow: 0 2px 10px color-mix(in srgb, black 12%, transparent); }
    .composer:focus-within { border-color: var(--accent); }
    textarea { display: block; width: 100%; min-height: 64px; max-height: 190px; padding: 9px 10px 5px; border: 0; resize: vertical; color: var(--vscode-input-foreground); background: transparent; font: inherit; line-height: 1.5; }
    textarea::placeholder { color: var(--vscode-input-placeholderForeground); } textarea[data-drop="true"] { background: color-mix(in srgb, var(--vscode-focusBorder) 13%, transparent); outline: 1px dashed var(--vscode-focusBorder); }
    .composer-actions { display: flex; align-items: center; gap: 3px; min-height: 35px; padding: 2px 5px 5px; }
    .control { display: inline-flex; align-items: center; gap: 4px; min-width: 28px; height: 28px; padding: 0 7px; border-radius: 14px; color: var(--muted); font-size: 12px; }
    .control:hover:not(:disabled) { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    .control:disabled { opacity: .45; cursor: default; }
    .dropdown { position: relative; } .dropdown > summary { list-style: none; } .dropdown > summary::-webkit-details-marker { display: none; } .dropdown > summary.control { cursor: pointer; } .dropdown[data-disabled="true"] > summary { opacity: .45; cursor: default; pointer-events: none; } .dropdown-menu { position: absolute; z-index: 20; bottom: 34px; left: 0; min-width: 168px; padding: 5px; border: 1px solid var(--vscode-menu-border, var(--line)); border-radius: 7px; color: var(--vscode-menu-foreground, var(--vscode-foreground)); background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); box-shadow: 0 5px 18px color-mix(in srgb, black 28%, transparent); } .dropdown-menu[data-wide="true"] { min-width: 210px; } .menu-choice { display: flex; width: 100%; align-items: center; gap: 7px; padding: 7px 8px; border-radius: 5px; color: inherit; text-align: left; font-size: 12px; } .menu-choice:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-menu-selectionForeground, var(--vscode-foreground)); } .menu-choice small { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 10px; } .model-dot { width: 8px; height: 8px; flex: none; border-radius: 50%; } .model-dot[data-model="deepseek-v4-pro"] { background: var(--vscode-charts-purple, #b180d7); box-shadow: 0 0 7px color-mix(in srgb, var(--vscode-charts-purple, #b180d7) 70%, transparent); } .model-dot[data-model="deepseek-v4-flash"] { background: var(--vscode-charts-yellow, #d7ba7d); box-shadow: 0 0 7px color-mix(in srgb, var(--vscode-charts-yellow, #d7ba7d) 65%, transparent); }
    #permission-picker[data-mode="read-only"] > summary { color: var(--vscode-testing-iconPassed); } #permission-picker[data-mode="danger-full-access"] > summary { color: var(--vscode-errorForeground); }
    #snapshot[data-enabled="true"] { color: var(--vscode-testing-iconPassed); }
    .spacer { flex: 1; }
    #send { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 50%; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font-size: 14px; }
    #send:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    #send:disabled { opacity: .45; cursor: default; }
    #key-warning { margin: 0 0 7px; color: var(--vscode-notificationsWarningIcon-foreground); font-size: 11px; }
    @media (max-width: 260px) { .brand { display: none; } #model { max-width: 70px; } .control-label { display: none; } }
    @media (prefers-reduced-motion: reduce) { .message, .state-dot[data-state="running"], .think[data-state="running"]::after, .tool[data-state="running"] .tool-state, .topbar[data-running="true"] .brand-mark { animation: none; } }
  </style>
</head>
<body>
  <div id="app">
    <header id="topbar" class="topbar" data-running="false"><span class="brand-mark" aria-hidden="true">◇</span><span class="brand">DeepSeek Harness</span><button id="new" class="icon-button" title="新建会话" aria-label="新建会话">＋</button><button id="configure" class="icon-button" title="配置 API 密钥" aria-label="配置 API 密钥">⚙</button></header>
    <div class="session-line"><span id="state-dot" class="state-dot" data-state="stopped"></span><span id="status">本地 Runner 未启动</span></div>
    <details id="todo-dock" hidden><summary><span aria-hidden="true">☷</span><span>任务</span><span id="todo-count" class="todo-count">0</span></summary><div id="todos"></div></details>
    <main id="conversation"></main>
    <div id="empty"><div><div class="empty-logo">◇</div><div class="empty-title">DeepSeek Harness</div><div class="empty-copy">从当前工作区开始。你可以附加代码、文件或 Problems，再让 Harness 读取、规划和执行。</div></div></div>
    <details id="changes-dock" hidden open><summary><span aria-hidden="true">▣</span><span>本轮文件变更</span><span id="changes-count">0</span></summary><div id="changes"></div></details>
    <section id="composer-seat"><div id="stats"></div><div id="attachments"></div><div id="key-warning" hidden>请先配置 DeepSeek API 密钥。</div><div class="composer"><textarea id="prompt" aria-label="向 DeepSeek Harness 提问" placeholder="向 DeepSeek Harness 提问…"></textarea><div class="composer-actions"><details id="context-picker" class="dropdown"><summary id="attach" class="control" title="选择上下文来源"><span aria-hidden="true">＋</span><span class="control-label">上下文</span><span aria-hidden="true">⌄</span></summary><div class="dropdown-menu" data-wide="true"><button class="menu-choice" data-context="selection">当前选区<small>代码片段</small></button><button class="menu-choice" data-context="document">当前文件<small>完整文件</small></button><button class="menu-choice" data-context="diagnostics">当前 Problems<small>错误和警告</small></button><button class="menu-choice" data-context="external">选择其他文件<small>任意文件夹</small></button></div></details><details id="model-picker" class="dropdown"><summary id="model" class="control" title="选择模型"><span id="model-dot" class="model-dot" data-model="deepseek-v4-flash"></span><span id="model-label">Flash</span><span aria-hidden="true">⌄</span></summary><div class="dropdown-menu"><button class="menu-choice" data-model="deepseek-v4-pro"><span class="model-dot" data-model="deepseek-v4-pro"></span>V4-Pro<small>完整推理</small></button><button class="menu-choice" data-model="deepseek-v4-flash"><span class="model-dot" data-model="deepseek-v4-flash"></span>Flash<small>快速响应</small></button></div></details><button id="snapshot" class="control" title="是否为本轮文件变更保存版本副本" aria-label="切换版本存档">存档：关</button><span class="spacer"></span><button id="stop" class="control" title="停止当前任务" aria-label="停止当前任务">■</button><button id="send" title="发送" aria-label="发送">↑</button></div></div></section>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi(); const messages = new Map(); let todos = []; let usage;
    const conversation = document.getElementById('conversation'); const empty = document.getElementById('empty'); const prompt = document.getElementById('prompt'); const attachments = document.getElementById('attachments'); const status = document.getElementById('status'); const stateDot = document.getElementById('state-dot'); const topbar = document.getElementById('topbar'); const keyWarning = document.getElementById('key-warning'); const send = document.getElementById('send'); const stop = document.getElementById('stop'); const model = document.getElementById('model'); const modelPicker = document.getElementById('model-picker'); const modelLabel = document.getElementById('model-label'); const modelDot = document.getElementById('model-dot'); const contextPicker = document.getElementById('context-picker'); const snapshot = document.getElementById('snapshot'); const changesDock = document.getElementById('changes-dock'); const changes = document.getElementById('changes');
    const history = document.createElement('button'); history.className = 'icon-button'; history.id = 'history'; history.title = 'Session history'; history.setAttribute('aria-label', 'Session history'); history.textContent = '◴'; document.getElementById('new').before(history);
    const folderChoice = document.createElement('button'); folderChoice.className = 'menu-choice'; folderChoice.dataset.context = 'folder'; folderChoice.textContent = 'Attach folder'; const folderHint = document.createElement('small'); folderHint.textContent = 'up to 30 files'; folderChoice.append(folderHint); contextPicker.querySelector('.dropdown-menu').append(folderChoice);
    const permissionPicker = document.createElement('details'); permissionPicker.className = 'dropdown'; permissionPicker.id = 'permission-picker'; const permissionSummary = document.createElement('summary'); permissionSummary.className = 'control'; permissionSummary.title = 'Harness access mode'; const permissionLabel = document.createElement('span'); permissionLabel.id = 'permission-label'; permissionSummary.append(permissionLabel, document.createTextNode('⌄')); const permissionMenu = document.createElement('div'); permissionMenu.className = 'dropdown-menu'; [['read-only', 'Read only', 'No file writes'], ['workspace-write', 'Workspace write', 'Workspace + approved temp'], ['danger-full-access', 'All access', 'No approval prompts']].forEach(function(item) { const choice = document.createElement('button'); choice.className = 'menu-choice'; choice.dataset.permission = item[0]; choice.append(document.createTextNode(item[1])); const hint = document.createElement('small'); hint.textContent = item[2]; choice.append(hint); permissionMenu.append(choice); }); permissionPicker.append(permissionSummary, permissionMenu); modelPicker.after(permissionPicker);
    function post(type, content) { vscode.postMessage(content === undefined ? { type: type } : { type: type, content: content }); }
    function line(text, last) { const normalized = text.trimEnd(); const index = normalized.lastIndexOf('\\n'); return last ? normalized.slice(index + 1) : text.slice(0, text.indexOf('\\n') === -1 ? text.length : text.indexOf('\\n')); }
    function toolSymbol(title) { const value = (title || '').toLowerCase(); if (value.includes('read') || value.includes('读取')) return '◫'; if (value.includes('search') || value.includes('查找')) return '⌕'; if (value.includes('write') || value.includes('edit') || value.includes('写入') || value.includes('编辑')) return '✎'; if (value.includes('bash') || value.includes('pwsh') || value.includes('shell')) return '⌁'; return '✦'; }
    function richText(parent, text) { const marker = String.fromCharCode(96, 96, 96); const parts = text.split(marker); parts.forEach(function(part, index) { if (!part) return; const block = document.createElement(index % 2 ? 'pre' : 'div'); block.className = index % 2 ? '' : 'plain'; block.textContent = index % 2 ? part.replace(/^[^\\n]*\\n?/, '') : part; parent.append(block); }); }
    function markdownText(parent, text) {
      const lineBreak = String.fromCharCode(10); const marker = String.fromCharCode(96, 96, 96); const lines = text.split(String.fromCharCode(13)).join('').split(lineBreak); let index = 0;
      function inline(target, value) { let cursor = 0; let plain = ''; function flush() { if (plain) { target.append(document.createTextNode(plain)); plain = ''; } } while (cursor < value.length) { const rest = value.slice(cursor); if (rest.startsWith('**')) { const end = value.indexOf('**', cursor + 2); if (end > cursor + 2) { flush(); const strong = document.createElement('strong'); inline(strong, value.slice(cursor + 2, end)); target.append(strong); cursor = end + 2; continue; } } if (value[cursor] === marker[0]) { const end = value.indexOf(marker[0], cursor + 1); if (end > cursor + 1) { flush(); const code = document.createElement('code'); code.textContent = value.slice(cursor + 1, end); target.append(code); cursor = end + 1; continue; } } plain += value[cursor]; cursor += 1; } flush(); }
      function tableCells(value) { let row = value.trim(); if (row.startsWith('|')) row = row.slice(1); if (row.endsWith('|')) row = row.slice(0, -1); return row.split('|').map(function(cell) { return cell.trim(); }); }
      function orderedContent(value) { const trimmed = value.trim(); let end = 0; while (end < trimmed.length && trimmed[end] >= '0' && trimmed[end] <= '9') end += 1; return end > 0 && (trimmed[end] === '.' || trimmed[end] === ')') && trimmed[end + 1] === ' ' ? trimmed.slice(end + 2) : undefined; }
      function bulletContent(value) { const trimmed = value.trim(); return (trimmed.startsWith('- ') || trimmed.startsWith('* ') || trimmed.startsWith('+ ')) ? trimmed.slice(2) : undefined; }
      function heading(value) { let level = 0; while (level < value.length && value[level] === '#') level += 1; return level >= 1 && level <= 3 && value[level] === ' ' ? { level: level, text: value.slice(level + 1) } : undefined; }
      function special(value) { return value.startsWith(marker) || heading(value) !== undefined || bulletContent(value) !== undefined || orderedContent(value) !== undefined || value.trim().startsWith('>') || value.includes('|'); }
      while (index < lines.length) {
        const current = lines[index]; if (current === undefined || current.trim() === '') { index += 1; continue; }
        if (current.startsWith(marker)) { const codeLines = []; index += 1; while (index < lines.length && !lines[index].startsWith(marker)) { codeLines.push(lines[index]); index += 1; } if (index < lines.length) index += 1; const pre = document.createElement('pre'); pre.textContent = codeLines.join(lineBreak); parent.append(pre); continue; }
        const currentHeading = heading(current); if (currentHeading !== undefined) { const node = document.createElement('h' + String(currentHeading.level)); node.className = 'md-heading'; inline(node, currentHeading.text); parent.append(node); index += 1; continue; }
        if (current.includes('|') && index + 1 < lines.length && lines[index + 1].includes('-') && lines[index + 1].includes('|')) { const wrap = document.createElement('div'); wrap.className = 'table-wrap'; const table = document.createElement('table'); table.className = 'markdown-table'; const head = document.createElement('thead'); const header = document.createElement('tr'); tableCells(current).forEach(function(cell) { const th = document.createElement('th'); inline(th, cell); header.append(th); }); head.append(header); table.append(head); index += 2; const body = document.createElement('tbody'); while (index < lines.length && lines[index].includes('|') && lines[index].trim() !== '') { const row = document.createElement('tr'); tableCells(lines[index]).forEach(function(cell) { const td = document.createElement('td'); inline(td, cell); row.append(td); }); body.append(row); index += 1; } table.append(body); wrap.append(table); parent.append(wrap); continue; }
        const firstBullet = bulletContent(current); const firstOrdered = orderedContent(current); if (firstBullet !== undefined || firstOrdered !== undefined) { const ordered = firstOrdered !== undefined; const list = document.createElement(ordered ? 'ol' : 'ul'); while (index < lines.length) { const itemText = ordered ? orderedContent(lines[index]) : bulletContent(lines[index]); if (itemText === undefined) break; const item = document.createElement('li'); inline(item, itemText); list.append(item); index += 1; } parent.append(list); continue; }
        if (current.trim().startsWith('>')) { const quote = []; while (index < lines.length && lines[index].trim().startsWith('>')) { const value = lines[index].trim(); quote.push(value.slice(value.startsWith('> ') ? 2 : 1)); index += 1; } const block = document.createElement('blockquote'); inline(block, quote.join(lineBreak)); parent.append(block); continue; }
        const paragraph = [current]; index += 1; while (index < lines.length && lines[index].trim() !== '' && !special(lines[index])) { paragraph.push(lines[index]); index += 1; } const node = document.createElement('p'); node.className = 'plain'; inline(node, paragraph.join(lineBreak)); parent.append(node);
      }
    }
    function renderMessage(message) { const node = document.createElement('article'); node.className = 'message ' + message.role; node.dataset.id = message.id; if (message.role === 'user') { node.textContent = message.text; return node; } if (message.role === 'assistant') { markdownText(node, message.text); return node; } if (message.role === 'thinking') { const details = document.createElement('details'); details.className = 'think'; details.dataset.state = message.state || 'ok'; if (message.state === 'running') details.open = true; const summary = document.createElement('summary'); const chevron = document.createElement('span'); chevron.className = 'disclosure'; chevron.textContent = '›'; const icon = document.createElement('span'); icon.className = 'think-icon'; icon.textContent = '◌'; const title = document.createElement('span'); title.className = 'think-title'; title.textContent = 'Think'; const sep = document.createElement('span'); sep.className = 'row-separator'; const glimpse = document.createElement('span'); glimpse.className = 'row-summary'; glimpse.textContent = line(message.text, message.state === 'running'); summary.append(chevron, icon, title, sep, glimpse); const body = document.createElement('div'); body.className = 'think-body'; body.textContent = message.text; details.append(summary, body); node.append(details); return node; } if (message.role === 'tool') { const details = document.createElement('details'); details.className = 'tool'; details.dataset.state = message.state || 'ok'; if (message.state === 'running') details.open = true; const summary = document.createElement('summary'); const chevron = document.createElement('span'); chevron.className = 'disclosure'; chevron.textContent = '›'; const icon = document.createElement('span'); icon.className = 'tool-icon'; icon.textContent = toolSymbol(message.title); const title = document.createElement('span'); title.className = 'tool-title'; title.textContent = message.title || 'Tool'; const state = document.createElement('span'); state.className = 'tool-state'; summary.append(chevron, icon, title, state); details.append(summary); if (message.text) { const output = document.createElement('pre'); output.className = 'tool-output'; output.textContent = message.text; details.append(output); } node.append(details); return node; } const title = document.createElement('div'); title.className = 'error-title'; title.textContent = message.title || 'DeepSeek Harness'; const body = document.createElement('div'); body.textContent = message.text; node.append(title, body); return node; }
    function renderMessages() { conversation.replaceChildren(); messages.forEach(function(message) { conversation.append(renderMessage(message)); }); empty.hidden = messages.size > 0; conversation.lastElementChild && conversation.lastElementChild.scrollIntoView({ block: 'end' }); }
    function renderAttachments(items) { attachments.replaceChildren(); items.forEach(function(item) { const chip = document.createElement('span'); chip.className = 'attachment'; const label = document.createElement('span'); label.className = 'attachment-label'; label.textContent = '⌁ ' + item.label; label.title = item.label; const remove = document.createElement('button'); remove.className = 'attachment-remove'; remove.type = 'button'; remove.title = 'Remove context'; remove.setAttribute('aria-label', 'Remove ' + item.label); remove.textContent = '×'; remove.addEventListener('click', function() { post('removeAttachment', item.id); }); chip.append(label, remove); attachments.append(chip); }); }
    function renderTodos() { const dock = document.getElementById('todo-dock'); const list = document.getElementById('todos'); const count = document.getElementById('todo-count'); list.replaceChildren(); count.textContent = String(todos.length); dock.hidden = todos.length === 0; todos.forEach(function(todo) { const row = document.createElement('div'); row.className = 'todo'; row.dataset.status = todo.status; const symbol = document.createElement('span'); symbol.className = 'todo-symbol'; symbol.textContent = todo.status === 'completed' ? '✓' : (todo.status === 'in_progress' ? '◉' : '○'); const text = document.createElement('span'); text.textContent = todo.content; row.append(symbol, text); list.append(row); }); }
    function renderChanges(items) { const count = document.getElementById('changes-count'); changes.replaceChildren(); count.textContent = String(items.length); changesDock.hidden = items.length === 0; items.forEach(function(item) { const row = document.createElement('div'); row.className = 'change-row'; const kind = document.createElement('span'); kind.className = 'change-kind'; kind.dataset.kind = item.kind; kind.textContent = item.kind === 'created' ? 'A' : (item.kind === 'deleted' ? 'D' : 'M'); const open = document.createElement('button'); open.className = 'change-open'; open.textContent = item.label; open.title = item.canCompare ? '在源文件中显示行级修改' : '打开 ' + item.label; open.addEventListener('click', function() { post('openChangedFile', item.uri); }); row.append(kind, open); const stats = document.createElement('button'); stats.className = 'change-stats'; stats.title = item.canCompare ? '在源文件中显示行级修改' : '打开文件'; const added = document.createElement('span'); added.className = 'added'; added.textContent = '+' + String(item.addedLines || 0); const removed = document.createElement('span'); removed.className = 'removed'; removed.textContent = '−' + String(item.removedLines || 0); stats.append(added, removed); stats.addEventListener('click', function() { post('openChangedFile', item.uri); }); row.append(stats); if (item.canUndo) { const undo = document.createElement('button'); undo.className = 'undo-change'; undo.textContent = '撤销'; undo.title = '仅撤销该文件的本轮修改'; undo.addEventListener('click', function() { post('undoChangedFile', item.uri); }); row.append(undo); } if (item.archiveAfter) { const archive = document.createElement('button'); archive.className = 'archive-open'; archive.textContent = '存档'; archive.title = item.archiveBefore ? '对比本轮存档' : '打开本轮存档'; archive.addEventListener('click', function() { post('openArchive', { before: item.archiveBefore, after: item.archiveAfter, label: item.label }); }); row.append(archive); } changes.append(row); }); }
    function renderUsage() { const stats = document.getElementById('stats'); if (!usage) { stats.textContent = ''; return; } stats.textContent = '输入 ' + compact(usage.inputTokens) + ' tokens  |  输出 ' + compact(usage.outputTokens) + ' tokens'; }
    function compact(value) { if (value < 1000) return String(value); if (value < 1000000) return (Math.round(value / 100) / 10) + 'K'; return (Math.round(value / 100000) / 10) + 'M'; }
    function setStatus(value) { const state = value.state || 'stopped'; stateDot.dataset.state = state; status.textContent = value.detail || state; const active = state === 'starting' || state === 'running'; topbar.dataset.running = active ? 'true' : 'false'; send.disabled = active; prompt.disabled = active; modelPicker.dataset.disabled = active ? 'true' : 'false'; permissionPicker.dataset.disabled = active ? 'true' : 'false'; if (active) { modelPicker.open = false; permissionPicker.open = false; } stop.disabled = state === 'stopped' || state === 'error'; }
    function setModel(value) { const normalized = value === 'deepseek-v4-pro' ? value : 'deepseek-v4-flash'; modelLabel.textContent = normalized === 'deepseek-v4-pro' ? 'V4-Pro' : 'Flash'; modelDot.dataset.model = normalized; model.title = normalized === 'deepseek-v4-pro' ? '当前模型：V4-Pro' : '当前模型：Flash'; }
    function setPermission(value) { const names = { 'read-only': 'Read only', 'workspace-write': 'Workspace write', 'danger-full-access': 'All access' }; const normalized = Object.prototype.hasOwnProperty.call(names, value) ? value : 'workspace-write'; permissionLabel.textContent = names[normalized]; permissionSummary.title = 'Harness access mode: ' + names[normalized]; permissionPicker.dataset.mode = normalized; }
    function setVersionSnapshots(enabled) { snapshot.dataset.enabled = enabled ? 'true' : 'false'; snapshot.textContent = enabled ? '存档：开' : '存档：关'; snapshot.title = enabled ? '本轮变更将保存版本副本' : '本轮变更不保存版本副本'; }
    function addMessage(message) { messages.set(message.id, message); renderMessages(); }
    function closeMenus(except) { [contextPicker, modelPicker, permissionPicker].forEach(function(picker) { if (picker !== except) picker.open = false; }); }
    document.getElementById('new').addEventListener('click', function() { post('newSession'); }); history.addEventListener('click', function() { post('sessionHistory'); }); document.getElementById('stop').addEventListener('click', function() { post('stopRunner'); }); document.getElementById('configure').addEventListener('click', function() { post('configureApiKey'); }); contextPicker.addEventListener('toggle', function() { if (contextPicker.open) closeMenus(contextPicker); }); modelPicker.addEventListener('toggle', function() { if (modelPicker.open) closeMenus(modelPicker); }); contextPicker.addEventListener('click', function(event) { const target = event.target instanceof Element ? event.target.closest('[data-context]') : undefined; if (!target) return; contextPicker.open = false; post('addContext', target.dataset.context); }); modelPicker.addEventListener('click', function(event) { const target = event.target instanceof Element ? event.target.closest('button[data-model]') : undefined; if (!target) return; modelPicker.open = false; post('setModel', target.dataset.model); }); document.addEventListener('click', function(event) { const target = event.target; if (target instanceof Node && !contextPicker.contains(target) && !modelPicker.contains(target)) closeMenus(); }); snapshot.addEventListener('click', function() { post('toggleVersionSnapshots'); }); send.addEventListener('click', function() { const value = prompt.value; if (value.trim()) { prompt.value = ''; post('prompt', value); } }); prompt.addEventListener('keydown', function(event) { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send.click(); } });
    permissionPicker.addEventListener('toggle', function() { if (permissionPicker.open) closeMenus(permissionPicker); }); permissionPicker.addEventListener('click', function(event) { const target = event.target instanceof Element ? event.target.closest('button[data-permission]') : undefined; if (!target) return; permissionPicker.open = false; post('setPermissionMode', target.dataset.permission); }); document.addEventListener('click', function(event) { const target = event.target; if (target instanceof Node && !permissionPicker.contains(target)) permissionPicker.open = false; });
    prompt.addEventListener('dragover', function(event) { event.preventDefault(); prompt.dataset.drop = 'true'; }); prompt.addEventListener('dragleave', function() { delete prompt.dataset.drop; }); prompt.addEventListener('drop', function(event) { event.preventDefault(); delete prompt.dataset.drop; const files = Array.from(event.dataTransfer.files).slice(0, 8); Promise.all(files.map(function(file) { return new Promise(function(resolve) { const reader = new FileReader(); reader.onload = function() { const result = typeof reader.result === 'string' ? reader.result : ''; const comma = result.indexOf(','); resolve({ name: file.name, mediaType: file.type, data: comma >= 0 ? result.slice(comma + 1) : '' }); }; reader.onerror = function() { resolve(undefined); }; reader.readAsDataURL(file); }); })).then(function(items) { post('droppedFiles', items.filter(Boolean)); }); });
    window.addEventListener('message', function(event) { const message = event.data; if (message.type === 'snapshot') { messages.clear(); message.messages.forEach(function(item) { messages.set(item.id, item); }); todos = message.todos || []; usage = message.usage; renderMessages(); renderAttachments(message.attachments || []); renderChanges(message.workspaceChanges || []); renderTodos(); renderUsage(); setModel(message.model); setPermission(message.permissionMode); setVersionSnapshots(message.versionSnapshots === true); setStatus(message.status); keyWarning.hidden = message.apiKeyConfigured; } if (message.type === 'message' || message.type === 'replaceMessage') addMessage(message.message); if (message.type === 'status') setStatus(message.status); if (message.type === 'todos') { todos = message.todos || []; renderTodos(); } if (message.type === 'usage') { usage = message.usage; renderUsage(); } if (message.type === 'clearAttachments') renderAttachments([]); if (message.type === 'notice') status.textContent = message.text; });
    window.addEventListener('message', function(event) { const message = event.data; if (message.type === 'attachments') renderAttachments(message.attachments || []); if (message.type === 'workspaceChanges') renderChanges(message.changes || []); });
  </script>
</body>
</html>`
}

function randomNonce(): string {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('')
}

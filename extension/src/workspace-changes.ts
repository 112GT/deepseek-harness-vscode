import * as path from 'node:path'
import * as vscode from 'vscode'

export type WorkspaceChangeKind = 'created' | 'modified' | 'deleted'

export interface WorkspaceChange {
  readonly uri: string
  readonly label: string
  readonly kind: WorkspaceChangeKind
  readonly addedLines: number
  readonly removedLines: number
  readonly canCompare: boolean
  readonly canUndo: boolean
  readonly archiveBefore?: string
  readonly archiveAfter?: string
}

interface MutableWorkspaceChange {
  readonly target: vscode.Uri
  kind: WorkspaceChangeKind
  beforeCaptured: boolean
  before?: string
  after?: string
  archiveBefore?: vscode.Uri
  archiveAfter?: vscode.Uri
}

const MAX_ARCHIVE_TEXT_BYTES = 1_000_000

/**
 * Tracks the files a single agent turn touches.  It deliberately writes
 * archives in an explicit project-local history folder when the user enables
 * that option.
 */
export class WorkspaceChangeTracker implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<readonly WorkspaceChange[]>()
  private watcher: vscode.FileSystemWatcher | undefined
  private root: vscode.Uri | undefined
  private active = false
  private readonly changes = new Map<string, MutableWorkspaceChange>()
  private readonly addedDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('diffEditorOverview.insertedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  })
  private readonly removedDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('diffEditorOverview.removedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    before: { contentText: '− Harness removed lines', color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'), margin: '0 0 0 0.5em' },
  })
  private highlightedEditor: vscode.TextEditor | undefined

  readonly onDidChange = this.changeEmitter.event

  constructor() {}

  async begin(): Promise<void> {
    this.stopWatching()
    this.changes.clear()
    this.clearInlineHighlights()
    this.root = vscode.workspace.workspaceFolders?.[0]?.uri
    this.active = this.root !== undefined && this.root.scheme === 'file'
    if (!this.active || this.root === undefined) {
      this.changeEmitter.fire([])
      return
    }
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.root, '**/*'))
    this.watcher.onDidCreate(uri => { this.mark(uri, 'created') })
    this.watcher.onDidChange(uri => { this.mark(uri, 'modified') })
    this.watcher.onDidDelete(uri => { this.mark(uri, 'deleted') })
    this.changeEmitter.fire([])
  }

  /** Captures the predecessor of a file before a write/edit tool mutates it. */
  captureToolTarget(toolName: string, rawArguments: string | undefined): void {
    if (!this.active || rawArguments === undefined || !mayChangeFiles(toolName)) return
    const candidate = pathFromArguments(rawArguments)
    if (candidate === undefined) return
    const target = this.resolveWorkspacePath(candidate)
    if (target !== undefined) void this.captureBefore(target)
  }

  /** Finalizes one turn, optionally persisting after-state copies to local extension storage. */
  async finish(saveArchive: boolean): Promise<readonly WorkspaceChange[]> {
    if (!this.active) return this.views()
    await delay(220)
    this.active = false
    this.stopWatching()
    for (const change of this.changes.values()) await this.readAfter(change)
    const retained = [...this.changes.values()].filter(change => isMeaningful(change))
    if (saveArchive && retained.length > 0) await this.archive(retained)
    const views = retained.map(changeView).sort((left, right) => left.label.localeCompare(right.label))
    this.changeEmitter.fire(views)
    return views
  }

  cancel(): void {
    this.active = false
    this.stopWatching()
  }

  /** Opens the real source document and overlays the latest turn's line changes. */
  async openChange(uri: string): Promise<void> {
    const change = this.changes.get(uri)
    if (change === undefined) return
    if (change.kind === 'deleted') return
    const document = await vscode.workspace.openTextDocument(change.target)
    const editor = await vscode.window.showTextDocument(document, { preview: true })
    this.clearInlineHighlights()
    this.highlightedEditor = editor
    if (!change.beforeCaptured || change.after === undefined) return
    const lines = lineChanges(change.before ?? '', change.after, change.kind)
    const added = lineRange(document, lines.firstChangedNewLine, lines.lastChangedNewLine)
    if (added !== undefined && lines.added > 0) editor.setDecorations(this.addedDecoration, [added])
    if (lines.removed > 0) {
      const anchor = Math.min(lines.firstChangedNewLine, Math.max(0, document.lineCount - 1))
      editor.setDecorations(this.removedDecoration, [new vscode.Range(anchor, 0, anchor, 0)])
    }
    if (added !== undefined) editor.revealRange(added, vscode.TextEditorRevealType.InCenter)
  }

  /** Restores one file only when it has not changed since the agent turn completed. */
  async undoChange(uri: string): Promise<void> {
    const change = this.changes.get(uri)
    if (change === undefined || !change.beforeCaptured) throw new Error('This file has no captured predecessor to restore.')
    const current = await readText(change.target)
    if (current !== change.after) throw new Error('The file changed after the Harness turn, so it was not overwritten.')
    if (change.before === undefined) {
      if (change.kind === 'created') await vscode.workspace.fs.delete(change.target, { recursive: false, useTrash: false })
      else throw new Error('The original contents were unavailable, so this file cannot be restored safely.')
    } else {
      await writeText(change.target, change.before)
    }
    this.changes.delete(uri)
    this.clearInlineHighlights()
    this.changeEmitter.fire(this.views())
  }

  async openArchive(before: string | undefined, after: string | undefined, label: string): Promise<void> {
    if (after === undefined) return
    const afterUri = vscode.Uri.parse(after)
    if (before === undefined) {
      const document = await vscode.workspace.openTextDocument(afterUri)
      await vscode.window.showTextDocument(document, { preview: true })
      return
    }
    await vscode.commands.executeCommand('vscode.diff', vscode.Uri.parse(before), afterUri, `Archive: ${label}`)
  }

  dispose(): void {
    this.stopWatching()
    this.clearInlineHighlights()
    this.addedDecoration.dispose()
    this.removedDecoration.dispose()
    this.changeEmitter.dispose()
  }

  private mark(uri: vscode.Uri, kind: WorkspaceChangeKind): void {
    if (!this.active || !this.belongsToWorkspace(uri) || isIgnored(uri)) return
    const existing = this.changes.get(uri.toString())
    if (existing !== undefined) {
      existing.kind = kind === 'deleted' ? 'deleted' : kind === 'created' || existing.kind === 'created' ? 'created' : 'modified'
    } else {
      this.changes.set(uri.toString(), { target: uri, kind, beforeCaptured: false })
    }
  }

  private async captureBefore(uri: vscode.Uri): Promise<void> {
    if (!this.active || !this.belongsToWorkspace(uri) || isIgnored(uri)) return
    const key = uri.toString()
    const change = this.changes.get(key) ?? { target: uri, kind: 'modified' as const, beforeCaptured: false }
    this.changes.set(key, change)
    if (change.beforeCaptured) return
    change.beforeCaptured = true
    change.before = await readText(uri)
  }

  private async readAfter(change: MutableWorkspaceChange): Promise<void> {
    if (change.kind === 'deleted') return
    const text = await readText(change.target)
    if (text === undefined) {
      change.kind = 'deleted'
      return
    }
    change.after = text
  }

  private async archive(changes: readonly MutableWorkspaceChange[]): Promise<void> {
    const nonce = Math.random().toString(36).slice(2, 8)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    if (this.root === undefined) return
    const folder = vscode.Uri.joinPath(this.root, '.deepseek-harness-history', `${stamp}-${nonce}`)
    await vscode.workspace.fs.createDirectory(folder)
    const manifest: Array<Record<string, unknown>> = []
    for (let index = 0; index < changes.length; index += 1) {
      const change = changes[index]
      if (change === undefined) continue
      const stem = String(index + 1).padStart(3, '0')
      const entry: Record<string, unknown> = { path: labelFor(change.target), kind: change.kind }
      if (change.before !== undefined) {
        const before = vscode.Uri.joinPath(folder, `${stem}.before.txt`)
        await writeText(before, change.before)
        change.archiveBefore = before
        entry.before = before.toString()
      }
      if (change.after !== undefined) {
        const after = vscode.Uri.joinPath(folder, `${stem}.after.txt`)
        await writeText(after, change.after)
        change.archiveAfter = after
        entry.after = after.toString()
      }
      manifest.push(entry)
    }
    await writeText(vscode.Uri.joinPath(folder, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), files: manifest }, undefined, 2))
  }

  private views(): readonly WorkspaceChange[] {
    return [...this.changes.values()].filter(isMeaningful).map(changeView).sort((left, right) => left.label.localeCompare(right.label))
  }

  private resolveWorkspacePath(candidate: string): vscode.Uri | undefined {
    if (this.root === undefined) return undefined
    const targetPath = path.isAbsolute(candidate) ? candidate : path.resolve(this.root.fsPath, candidate)
    const relative = path.relative(this.root.fsPath, targetPath)
    if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined
    return vscode.Uri.file(targetPath)
  }

  private belongsToWorkspace(uri: vscode.Uri): boolean {
    if (this.root === undefined || uri.scheme !== this.root.scheme) return false
    const relative = path.relative(this.root.fsPath, uri.fsPath)
    return relative !== '' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  }

  private stopWatching(): void {
    this.watcher?.dispose()
    this.watcher = undefined
  }

  private clearInlineHighlights(): void {
    if (this.highlightedEditor !== undefined) {
      this.highlightedEditor.setDecorations(this.addedDecoration, [])
      this.highlightedEditor.setDecorations(this.removedDecoration, [])
    }
    this.highlightedEditor = undefined
  }
}

/** Adds A/M/D badges to the same files in VS Code's normal Explorer. */
export class WorkspaceChangeDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri[]>()
  private readonly entries = new Map<string, WorkspaceChangeKind>()
  private readonly listener: vscode.Disposable

  readonly onDidChangeFileDecorations = this.changeEmitter.event

  constructor(tracker: WorkspaceChangeTracker) {
    this.listener = tracker.onDidChange(changes => {
      const affected = [...this.entries.keys()].map(value => vscode.Uri.parse(value))
      this.entries.clear()
      for (const change of changes) {
        this.entries.set(change.uri, change.kind)
        affected.push(vscode.Uri.parse(change.uri))
      }
      this.changeEmitter.fire(affected)
    })
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const kind = this.entries.get(uri.toString())
    if (kind === undefined) return undefined
    if (kind === 'created') return new vscode.FileDecoration('A', 'Created by the latest DeepSeek Harness turn.', new vscode.ThemeColor('gitDecoration.addedResourceForeground'))
    if (kind === 'deleted') return new vscode.FileDecoration('D', 'Deleted by the latest DeepSeek Harness turn.', new vscode.ThemeColor('gitDecoration.deletedResourceForeground'))
    return new vscode.FileDecoration('M', 'Modified by the latest DeepSeek Harness turn.', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'))
  }

  dispose(): void {
    this.listener.dispose()
    this.changeEmitter.dispose()
  }
}

function mayChangeFiles(toolName: string): boolean {
  return /(write|edit|patch|create|delete|move|copy|mkdir|rename)/i.test(toolName)
}

function pathFromArguments(raw: string): string | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    return findPath(value)
  } catch {
    return undefined
  }
}

function findPath(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  for (const key of ['path', 'filePath', 'file_path', 'target', 'destination', 'uri']) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.length > 0 && !candidate.startsWith('file:')) return candidate
  }
  return undefined
}

function isIgnored(uri: vscode.Uri): boolean {
  const segments = uri.fsPath.split(/[\\/]/)
  const name = segments.at(-1)?.toLowerCase() ?? ''
  return name.endsWith('.pyc') || name.endsWith('.pyo') || segments.some(segment => segment === '__pycache__' || segment === '.deepseek-harness-history')
}

function isMeaningful(change: MutableWorkspaceChange): boolean {
  if (change.kind === 'deleted') return true
  if (change.after === undefined) return false
  return !change.beforeCaptured || change.before !== change.after || change.kind === 'created'
}

function changeView(change: MutableWorkspaceChange): WorkspaceChange {
  const lines = lineChanges(change.beforeCaptured ? change.before ?? '' : undefined, change.after, change.kind)
  return {
    uri: change.target.toString(),
    label: labelFor(change.target),
    kind: change.kind,
    addedLines: lines.added,
    removedLines: lines.removed,
    canCompare: change.beforeCaptured && (change.before ?? '') !== (change.after ?? ''),
    canUndo: change.beforeCaptured && (change.before ?? '') !== (change.after ?? ''),
    ...(change.archiveBefore === undefined ? {} : { archiveBefore: change.archiveBefore.toString() }),
    ...(change.archiveAfter === undefined ? {} : { archiveAfter: change.archiveAfter.toString() }),
  }
}

function labelFor(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, true) || uri.fsPath
}

/**
 * A bounded line summary for the file card. It keeps identical prefix/suffix
 * lines out of the count, which is what a user needs to decide where to look.
 */
interface LineChanges {
  readonly added: number
  readonly removed: number
  readonly firstChangedNewLine: number
  readonly lastChangedNewLine: number
}

function lineChanges(before: string | undefined, after: string | undefined, kind: WorkspaceChangeKind): LineChanges {
  if (kind === 'created') return { added: countLines(after), removed: 0, firstChangedNewLine: 0, lastChangedNewLine: Math.max(0, countLines(after) - 1) }
  if (kind === 'deleted') return { added: 0, removed: countLines(before), firstChangedNewLine: 0, lastChangedNewLine: -1 }
  if (before === undefined || after === undefined) return { added: 0, removed: 0, firstChangedNewLine: 0, lastChangedNewLine: -1 }
  const oldLines = before.split('\n')
  const newLines = after.split('\n')
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1
  let oldTail = oldLines.length - 1
  let newTail = newLines.length - 1
  while (oldTail >= prefix && newTail >= prefix && oldLines[oldTail] === newLines[newTail]) {
    oldTail -= 1
    newTail -= 1
  }
  return {
    added: Math.max(0, newTail - prefix + 1),
    removed: Math.max(0, oldTail - prefix + 1),
    firstChangedNewLine: prefix,
    lastChangedNewLine: newTail,
  }
}

function countLines(value: string | undefined): number {
  if (value === undefined || value.length === 0) return 0
  return value.split('\n').length
}

function lineRange(document: vscode.TextDocument, first: number, last: number): vscode.Range | undefined {
  if (first < 0 || last < first || first >= document.lineCount) return undefined
  const final = Math.min(last, document.lineCount - 1)
  return new vscode.Range(first, 0, final, document.lineAt(final).range.end.character)
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const stat = await vscode.workspace.fs.stat(uri)
    if ((stat.type & vscode.FileType.File) === 0 || stat.size > MAX_ARCHIVE_TEXT_BYTES) return undefined
    const bytes = await vscode.workspace.fs.readFile(uri)
    if (bytes.includes(0)) return undefined
    return new TextDecoder().decode(bytes)
  } catch {
    return undefined
  }
}

async function writeText(uri: vscode.Uri, value: string): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(value))
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, milliseconds) })
}

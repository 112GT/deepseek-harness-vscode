import * as path from 'node:path'
import * as vscode from 'vscode'

interface FileMutation {
  readonly target: vscode.Uri
  readonly before: string
  readonly after: string
}

/**
 * Lets the user inspect the predicted write before answering the Harness
 * approval RPC. Preview documents are read-only memory URIs, never untitled
 * editors, so VS Code never asks the user to save them.
 */
export class PrewriteReviewService implements vscode.TextDocumentContentProvider, vscode.Disposable {
  readonly scheme = 'deepseek-harness-review'
  private readonly contents = new Map<string, string>()
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>()
  readonly onDidChange = this.changeEmitter.event

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? ''
  }

  async requestDecision(toolName: string, serializedArguments: string | undefined, fallbackReason: string): Promise<'allowed-once' | 'rejected'> {
    const preview = vscode.workspace.getConfiguration('deepseekHarness').get<boolean>('editReview', true)
      ? await this.mutationFromArguments(serializedArguments)
      : undefined
    const detail = preview === undefined
      ? 'The local Harness Host requests one-time permission for this tool.'
      : `${workspaceLabel(preview.target)}\n${lineDelta(preview.before, preview.after)}`
    while (true) {
      const selection = await vscode.window.showWarningMessage(
        `${toolName} is about to modify a workspace file. ${fallbackReason}`,
        { modal: true, detail },
        ...(preview === undefined ? [] : ['Preview change']),
        'Allow once',
        'Reject',
      )
      if (selection === 'Preview change' && preview !== undefined) {
        await this.openPreview(preview, toolName)
        continue
      }
      return selection === 'Allow once' ? 'allowed-once' : 'rejected'
    }
  }

  dispose(): void {
    this.contents.clear()
    this.changeEmitter.dispose()
  }

  private async mutationFromArguments(serialized: string | undefined): Promise<FileMutation | undefined> {
    const args = jsonRecord(serialized)
    if (args === undefined) return undefined
    const rawPath = firstString(args, ['path', 'filePath', 'file_path', 'target'])
    if (rawPath === undefined) return undefined
    const target = withinWorkspace(rawPath)
    if (target === undefined) return undefined
    const before = await readText(target)
    const fullText = firstString(args, ['content', 'text', 'newText', 'new_text'])
    if (fullText !== undefined) return { target, before, after: fullText }
    const oldText = firstString(args, ['oldString', 'old_string', 'oldText', 'old_text'])
    const newText = firstString(args, ['newString', 'new_string', 'replaceWith', 'replace_with'])
    if (oldText !== undefined && newText !== undefined && before.includes(oldText)) {
      return { target, before, after: before.replace(oldText, newText) }
    }
    return undefined
  }

  private async openPreview(mutation: FileMutation, toolName: string): Promise<void> {
    const before = this.memoryUri('before', mutation.target)
    const after = this.memoryUri('after', mutation.target)
    this.contents.set(before.toString(), mutation.before)
    this.contents.set(after.toString(), mutation.after)
    this.changeEmitter.fire(before)
    this.changeEmitter.fire(after)
    await vscode.commands.executeCommand(
      'vscode.diff', before, after,
      `Harness review: ${path.basename(mutation.target.fsPath)} (${toolName})`,
      { preview: true, preserveFocus: false },
    )
  }

  private memoryUri(kind: string, target: vscode.Uri): vscode.Uri {
    const suffix = path.extname(target.fsPath) || '.txt'
    return vscode.Uri.parse(`${this.scheme}:/${kind}-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`)
  }
}

function jsonRecord(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function firstString(value: Record<string, unknown>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const candidate = value[name]
    if (typeof candidate === 'string') return candidate
  }
  return undefined
}

function withinWorkspace(candidate: string): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (folder === undefined) return undefined
  const resolved = path.resolve(folder, candidate)
  const relative = path.relative(folder, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined
  return vscode.Uri.file(resolved)
}

async function readText(uri: vscode.Uri): Promise<string> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri)
    if (bytes.byteLength > 1_000_000 || bytes.includes(0)) return ''
    return new TextDecoder().decode(bytes)
  } catch {
    return ''
  }
}

function workspaceLabel(uri: vscode.Uri): string {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  return folder === undefined ? uri.fsPath : path.relative(folder, uri.fsPath)
}

function lineDelta(before: string, after: string): string {
  const oldLines = before.length === 0 ? 0 : before.split('\n').length
  const newLines = after.length === 0 ? 0 : after.split('\n').length
  const delta = newLines - oldLines
  return `${oldLines} → ${newLines} lines${delta === 0 ? '' : ` (${delta > 0 ? '+' : ''}${String(delta)})`}`
}

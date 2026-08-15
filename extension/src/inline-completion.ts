import * as vscode from 'vscode'

const FIM_ENDPOINT = 'https://api.deepseek.com/beta/completions'
const MAX_PREFIX_CHARS = 8_000
const MAX_SUFFIX_CHARS = 3_000

interface FimResponse {
  readonly choices?: readonly { readonly text?: unknown }[]
}

/**
 * A deliberately small FIM client for editor ghost text. It is independent of
 * the agent sidecar so an editor keystroke never waits for an agent turn.
 */
export class DeepSeekInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  constructor(private readonly apiKey: () => Promise<string | undefined>) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const settings = vscode.workspace.getConfiguration('deepseekHarness.inlineCompletion')
    if (!settings.get<boolean>('enabled', true) || !eligibleDocument(document)) return undefined
    const apiKey = await this.apiKey()
    if (apiKey === undefined || token.isCancellationRequested) return undefined

    const cursor = document.offsetAt(position)
    const source = document.getText()
    const prompt = source.slice(Math.max(0, cursor - MAX_PREFIX_CHARS), cursor)
    const suffix = source.slice(cursor, cursor + MAX_SUFFIX_CHARS)
    if (prompt.trim().length === 0 || token.isCancellationRequested) return undefined

    const controller = new AbortController()
    const cancellation = token.onCancellationRequested(() => controller.abort())
    try {
      const response = await fetch(FIM_ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          // The FIM endpoint documents V4-Pro. Chat model selection remains independent.
          model: 'deepseek-v4-pro',
          prompt,
          suffix,
          max_tokens: settings.get<number>('maxTokens', 128),
          temperature: 0.2,
        }),
        signal: controller.signal,
      })
      if (!response.ok || token.isCancellationRequested) return undefined
      const payload = await response.json() as FimResponse
      const completion = payload.choices?.[0]?.text
      if (typeof completion !== 'string' || completion.length === 0) return undefined
      const deduplicated = withoutForwardDuplicate(completion, suffix)
      if (deduplicated.length === 0) return undefined
      return [new vscode.InlineCompletionItem(deduplicated, new vscode.Range(position, position))]
    } catch (error) {
      // Abort and transient network failures must never create an editor error toast.
      if (!token.isCancellationRequested && !(error instanceof DOMException && error.name === 'AbortError')) return undefined
      return undefined
    } finally {
      cancellation.dispose()
    }
  }
}

function eligibleDocument(document: vscode.TextDocument): boolean {
  return document.uri.scheme === 'file'
    && document.languageId !== 'log'
    && document.languageId !== 'output'
    && document.languageId !== 'git-commit'
}

function withoutForwardDuplicate(completion: string, suffix: string): string {
  for (let size = Math.min(completion.length, suffix.length); size > 0; size -= 1) {
    if (completion.slice(-size) === suffix.slice(0, size)) return completion.slice(0, -size)
  }
  return completion
}

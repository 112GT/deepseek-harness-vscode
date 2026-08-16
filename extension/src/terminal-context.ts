import * as vscode from 'vscode'

const MAX_CAPTURED_TERMINAL_CHARS = 64_000

/**
 * Keeps a bounded, in-memory transcript of terminal commands started after the
 * extension activates. VS Code deliberately does not expose prior terminal
 * scrollback, so attaching a terminal never reads data that was not observed
 * by the extension while shell integration was active.
 */
export class TerminalContextRecorder implements vscode.Disposable {
  private readonly transcripts = new Map<vscode.Terminal, string>()
  private readonly disposable: vscode.Disposable

  constructor() {
    this.disposable = vscode.window.onDidStartTerminalShellExecution(event => {
      void this.capture(event.terminal, event.execution)
    })
  }

  activeTranscript(): { readonly label: string; readonly content: string } | undefined {
    const terminal = vscode.window.activeTerminal
    if (terminal === undefined) return undefined
    const content = this.transcripts.get(terminal)?.trim()
    return content === undefined || content.length === 0
      ? undefined
      : { label: `Terminal: ${terminal.name}`, content }
  }

  dispose(): void {
    this.disposable.dispose()
    this.transcripts.clear()
  }

  private async capture(terminal: vscode.Terminal, execution: vscode.TerminalShellExecution): Promise<void> {
    this.append(terminal, `\n$ ${execution.commandLine.value}\n`)
    try {
      for await (const chunk of execution.read()) this.append(terminal, cleanTerminalData(chunk))
    } catch {
      // Terminal closure and unsupported shell integrations can end a stream.
      // The successfully captured prefix remains available for attachment.
    }
  }

  private append(terminal: vscode.Terminal, text: string): void {
    const combined = `${this.transcripts.get(terminal) ?? ''}${text}`
    this.transcripts.set(terminal, combined.length <= MAX_CAPTURED_TERMINAL_CHARS
      ? combined
      : `… terminal output truncated …\n${combined.slice(-MAX_CAPTURED_TERMINAL_CHARS)}`)
  }
}

function cleanTerminalData(value: string): string {
  // Preserve line content while dropping the common ANSI control sequences that
  // make a prompt attachment unreadable. This is intentionally conservative.
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
}

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/** A JSON-RPC notification emitted by the Harness SDK process. */
export interface JsonRpcNotification {
  readonly method: string
  readonly params: unknown
}

/** Launch parameters for the stdio-only Harness SDK process. */
export interface JsonRpcRuntimeLaunch {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}

interface PendingRequest {
  readonly resolve: (result: unknown) => void
  readonly reject: (error: Error) => void
  readonly timeout: NodeJS.Timeout
}

/**
 * Owns one newline-delimited JSON-RPC process. Harness diagnostics remain on
 * stderr, while stdout is parsed strictly as protocol frames.
 */
export class JsonRpcRuntime {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly stderrLines: string[] = []
  private nextRequestId = 1
  private stdoutBuffer = ''
  private closed = false

  readonly process: ChildProcessWithoutNullStreams

  constructor(
    launch: JsonRpcRuntimeLaunch,
    private readonly onNotification: (notification: JsonRpcNotification) => void,
    private readonly onUnexpectedExit: (message: string) => void,
  ) {
    this.process = spawn(launch.command, [...launch.args], {
      cwd: launch.cwd,
      env: launch.env,
      stdio: 'pipe',
      windowsHide: true,
    })
    this.process.stdout.setEncoding('utf8')
    this.process.stderr.setEncoding('utf8')
    this.process.stdout.on('data', (chunk: string) => this.consumeStdout(chunk))
    this.process.stderr.on('data', (chunk: string) => this.captureStderr(chunk))
    this.process.once('error', error => this.fail(`Unable to start the Harness Runner: ${error.message}`))
    this.process.once('exit', (code, signal) => {
      if (this.closed) return
      this.fail(`Harness Runner stopped unexpectedly (${exitDescription(code, signal)}).${this.stderrTail()}`)
    })
  }

  /** Sends one JSON-RPC request and waits for the matching response. */
  request(method: string, params: unknown, timeoutMs = 20_000): Promise<unknown> {
    if (this.closed || !this.process.stdin.writable) {
      return Promise.reject(new Error('The Harness Runner is not running.'))
    }
    const id = String(this.nextRequestId++)
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Harness Runner did not answer ${method} within ${timeoutMs} ms.`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timeout })
      const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params })
      this.process.stdin.write(`${frame}\n`, error => {
        if (error === undefined || error === null) return
        const pending = this.pending.get(id)
        if (pending === undefined) return
        this.pending.delete(id)
        clearTimeout(pending.timeout)
        pending.reject(new Error(`Unable to send ${method} to the Harness Runner: ${error.message}`))
      })
    })
  }

  /** Requests orderly shutdown, then closes the child input stream. */
  async stop(): Promise<void> {
    if (this.closed) return
    try {
      await this.request('shutdown', undefined, 4_000)
    } catch {
      // A dying runtime can reject shutdown while still exiting normally.
    }
    this.closed = true
    this.process.stdin.end()
    await waitForExit(this.process, 2_500)
    if (this.process.exitCode === null && !this.process.killed) this.process.kill()
    this.rejectPending(new Error('The Harness Runner was stopped.'))
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n')
      if (newline < 0) return
      const line = this.stdoutBuffer.slice(0, newline).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (line.length === 0) continue
      this.consumeFrame(line)
    }
  }

  private consumeFrame(line: string): void {
    let frame: unknown
    try {
      frame = JSON.parse(line)
    } catch {
      this.fail('Harness Runner wrote a non-JSON frame to its protocol output.')
      return
    }
    if (frame === null || typeof frame !== 'object') return
    const record = frame as Record<string, unknown>
    if (typeof record.method === 'string' && !('id' in record)) {
      this.onNotification({ method: record.method, params: record.params })
      return
    }
    if (!('id' in record)) return
    const id = String(record.id)
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    clearTimeout(pending.timeout)
    if (record.error !== undefined) {
      pending.reject(new Error(`Harness Runner rejected the request: ${errorText(record.error)}`))
      return
    }
    pending.resolve(record.result)
  }

  private captureStderr(chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.length > 0) this.stderrLines.push(trimmed)
    }
    if (this.stderrLines.length > 20) this.stderrLines.splice(0, this.stderrLines.length - 20)
  }

  private fail(message: string): void {
    if (this.closed) return
    this.closed = true
    this.rejectPending(new Error(message))
    this.onUnexpectedExit(message)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private stderrTail(): string {
    const tail = this.stderrLines.slice(-4).join(' | ')
    return tail.length === 0 ? '' : ` Diagnostics: ${tail}`
  }
}

function errorText(value: unknown): string {
  if (value === null || typeof value !== 'object') return String(value)
  const record = value as Record<string, unknown>
  return typeof record.message === 'string' ? record.message : JSON.stringify(value)
}

function exitDescription(code: number | null, signal: NodeJS.Signals | null): string {
  return signal === null ? `exit code ${String(code)}` : `signal ${signal}`
}

function waitForExit(process: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (process.exitCode !== null || process.killed) return Promise.resolve()
  return new Promise(resolve => {
    const timeout = setTimeout(finish, timeoutMs)
    process.once('exit', finish)
    function finish(): void {
      clearTimeout(timeout)
      process.removeListener('exit', finish)
      resolve()
    }
  })
}

import * as path from 'node:path'
import * as vscode from 'vscode'

/** A source-runtime check for the locally copied Harness checkout. */
export interface HarnessSourceStatus {
  readonly state: 'ready' | 'missing' | 'incompatible'
  readonly root: vscode.Uri
  readonly detail: string
  readonly version?: string
}

/** Locates and validates the copied Harness source before local Runner startup. */
export class HarnessSourceLocator implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>()
  private readonly configurationListener: vscode.Disposable

  /** Fires when a setting affecting the source location changes. */
  readonly onDidChange = this.changeEmitter.event

  constructor(private readonly extensionUri: vscode.Uri) {
    this.configurationListener = vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('deepseekHarness.harnessPath')) this.changeEmitter.fire()
    })
  }

  /** Reads the configured source package and checks that it is a Harness checkout. */
  async inspect(): Promise<HarnessSourceStatus> {
    const root = this.resolveRoot()
    const packageUri = vscode.Uri.joinPath(root, 'package.json')
    try {
      const bytes = await vscode.workspace.fs.readFile(packageUri)
      const parsed = parsePackageJson(new TextDecoder().decode(bytes))
      if (parsed.name !== '@deepseek-ai/dsh-root') {
        return { state: 'incompatible', root, detail: 'package.json is not a DeepSeek Harness root package.' }
      }
      return {
        state: 'ready',
        root,
        detail: 'Harness source is available.',
        version: parsed.version,
      }
    } catch (error) {
      return {
        state: 'missing',
        root,
        detail: `Harness runtime was not found at ${root.fsPath}. Run “DeepSeek Harness: Select Harness Folder” and select the folder that contains Harness package.json. (${errorMessage(error)})`,
      }
    }
  }

  /** Resolves the source root relative to the extension unless an absolute path is configured. */
  private resolveRoot(): vscode.Uri {
    const configured = vscode.workspace.getConfiguration('deepseekHarness').get<string>('harnessPath', '../harness').trim()
    if (path.isAbsolute(configured)) return vscode.Uri.file(configured)
    return vscode.Uri.file(path.resolve(this.extensionUri.fsPath, configured))
  }

  dispose(): void {
    this.configurationListener.dispose()
    this.changeEmitter.dispose()
  }
}

function parsePackageJson(source: string): { name?: string; version?: string } {
  const value: unknown = JSON.parse(source)
  if (value === null || typeof value !== 'object') return {}
  const record = value as Record<string, unknown>
  return {
    name: typeof record.name === 'string' ? record.name : undefined,
    version: typeof record.version === 'string' ? record.version : undefined,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

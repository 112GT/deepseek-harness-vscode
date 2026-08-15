/** The stable extension-to-Runner contract. It must not expose Cordis internals. */
export const RUNNER_PROTOCOL_VERSION = 1

/** Runner capabilities returned by the initial handshake. */
export interface RunnerCapabilities {
  readonly sessions: boolean
  readonly streaming: boolean
  readonly cancellation: boolean
  readonly approvals: boolean
  readonly questions: boolean
  readonly fileProposals: boolean
  readonly terminals: boolean
  readonly languageServers: boolean
  readonly mcp: boolean
  readonly skills: boolean
  readonly subagents: boolean
  readonly workflows: boolean
  readonly schedules: boolean
  readonly pluginManagement: boolean
}

/** Versioned identification returned by a Runner. */
export interface RunnerHandshake {
  readonly protocolVersion: number
  readonly harnessVersion: string
  readonly capabilities: RunnerCapabilities
}

/** Request from the extension UI to a workspace-bound Harness session. */
export interface PromptRequest {
  readonly sessionId: string
  readonly workspaceFolder: string
  readonly content: string
  readonly attachments: readonly PromptAttachment[]
}

/** Editor context that can be deliberately attached to a user request. */
export type PromptAttachment = TextPromptAttachment | ImagePromptAttachment

/** Textual context deliberately included with a prompt. */
export interface TextPromptAttachment {
  readonly kind: 'document' | 'selection' | 'diagnostic' | 'terminal'
  readonly uri?: string
  readonly label: string
  readonly content: string
}

/** A small, user-selected image. The base64 payload never leaves memory. */
export interface ImagePromptAttachment {
  readonly kind: 'image'
  readonly uri?: string
  readonly label: string
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  readonly data: string
}

/** Events a Runner may stream to every supported VS Code presentation. */
export type RunnerEvent =
  | { readonly kind: 'assistant-delta'; readonly sessionId: string; readonly text: string }
  | { readonly kind: 'reasoning-delta'; readonly sessionId: string; readonly text: string }
  | { readonly kind: 'assistant-message'; readonly sessionId: string; readonly markdown: string }
  | { readonly kind: 'usage'; readonly sessionId: string; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly kind: 'todo'; readonly sessionId: string; readonly todos: readonly RunnerTodoItem[] }
  | { readonly kind: 'status'; readonly sessionId: string; readonly state: 'idle' | 'running' | 'waiting' | 'error'; readonly detail?: string }
  | { readonly kind: 'tool-call'; readonly sessionId: string; readonly callId: string; readonly title: string; readonly detail?: string }
  | { readonly kind: 'tool-result'; readonly sessionId: string; readonly callId: string; readonly summary: string; readonly isError: boolean }
  | { readonly kind: 'approval-request'; readonly sessionId: string; readonly requestId: string; readonly title: string; readonly detail: string }
  | { readonly kind: 'question-request'; readonly sessionId: string; readonly requestId: string; readonly question: string; readonly options: readonly string[] }
  | { readonly kind: 'file-proposal'; readonly sessionId: string; readonly proposalId: string; readonly uri: string; readonly original: string; readonly proposed: string }
  | { readonly kind: 'error'; readonly sessionId?: string; readonly message: string }

/** A task item projected by Harness's durable todo/write session event. */
export interface RunnerTodoItem {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

/** User-controlled decision returned to the Runner for a pending interaction. */
export interface InteractionResponse {
  readonly requestId: string
  readonly kind: 'approval' | 'question'
  readonly accepted?: boolean
  readonly answer?: string
}

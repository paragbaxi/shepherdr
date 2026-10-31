import type { AgentRuntime, Mode } from '../../shared/types.ts'

/** `agy` (Antigravity) only ever takes a task over as its backup: nothing can be started on it directly. */
export type AgentKind = 'claude' | 'codex' | 'agy'
export interface CoreSpace {
  id: string
  name: string
  machine: string
  folder: string
  home?: boolean
  base: string
  prefix: string
  mode: Mode
  added: number
  removed?: number
}
export interface CoreAgent {
  chat: string
  space: string
  machine: string
  role: 'coordinator' | 'task' | 'reviewer'
  kind: AgentKind
  model?: string
  effort?: string
  runtime?: AgentRuntime
  terminal?: string
  pid?: number
  launch: string
  grant: string
  hook: string
  command?: string
  browser?: { namespace: string; session: string; profile: string }
  transcript?: string
  transcriptFormat?: 'codex-exec'
  session?: string
  started: number
  activityAt?: number
  state: 'starting' | 'idle' | 'working' | 'blocked'
  permission?: string
  /** App-private contained launch metadata. Labels and request bodies never establish this ownership. */
  pilot?: { run: string; home: string; captures: string; pending?: boolean }
}
export interface AgentHook {
  id: string
  event: string
  at: number
  session?: string
  transcript?: string
  transcriptFormat?: 'codex-exec'
  agent?: string
  model?: string
  tool?: string
  /** Antigravity's Stop hook: why its turn ended early, in its own words. */
  error?: string
}

#!/usr/bin/env bun
// Per-launch Antigravity hooks: the same record and the same permission card as core-hook.ts, in its CLI's own terms.
// Antigravity's hooks answer on stdout with a JSON object, always; a failed permission request always denies.
import { appendFileSync, existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readCredential } from '../server/core/home.ts'
import { coreRequest } from '../server/core/request.ts'
import type { CoreEndpoint } from '../server/core/client.ts'
import type { MailCredential } from '../server/core/envelope.ts'
import type { AgentHook } from '../server/core/model.ts'
import { agyToolCheck } from './core-agy-policy.ts'

const NATIVE = process.argv[2] ?? '', WORKTREE = process.argv[3] ?? ''
/** Where a path really leads, for what exists of it. */
const real = (path: string): string => { try { return existsSync(path) ? realpathSync(path) : dirname(path) === path ? path : join(real(dirname(path)), basename(path)) } catch { return path } }
/** Shepherdr's own names for what each hook means; other hooks say nothing it needs. */
const EVENTS: Record<string, string> = { SessionStart: 'SessionStart', PreInvocation: 'UserPromptSubmit', PreToolUse: 'PreToolUse', Stop: 'Stop' }
const CHECKED = NATIVE === 'PreToolUse'
let answer: Record<string, unknown> = {}
try {
  const raw = await Bun.stdin.text()
  if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('Hook input too large')
  const input = JSON.parse(raw)
  const credentialFile = process.env.SHEPHERDR_CORE_CREDENTIAL, hookFile = process.env.SHEPHERDR_CORE_HOOK_FILE, command = process.env.SHEPHERDR_COMMAND
  if (!credentialFile || !hookFile || !command) throw new Error('Missing launch identity')
  const cut = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, max) : undefined
  const base = {
    at: Date.now(), session: cut(input.conversationId, 128), transcript: cut(input.transcriptPath, 4096), model: cut(input.modelName, 128),
    tool: cut(input.toolCall?.name, 128),
  }
  const write = (event: AgentHook) => appendFileSync(hookFile, JSON.stringify(event) + '\n', { mode: 0o600 })
  const failed = NATIVE === 'Stop' && input.terminationReason === 'ERROR' ? cut(input.error, 2000) || 'Provider error' : undefined
  if (EVENTS[NATIVE]) write({ id: randomUUID(), event: EVENTS[NATIVE], ...base, ...(failed ? { error: failed } : {}) })
  if (CHECKED) {
    // Its own plans and notes go in its own conversation folder, which is no one else's to read.
    const own = typeof input.artifactDirectoryPath === 'string' ? [input.artifactDirectoryPath] : []
    const check = agyToolCheck(input.toolCall ?? {}, { folders: [WORKTREE, ...own], command, hooks: JSON.parse(process.argv[4] || '[]'), real })
    // Its commands start in its first workspace folder, which is meant to sort as the worktree: this holds if it doesn't.
    const elsewhere = input.toolCall?.name === 'run_command' && !input.toolCall?.args?.Cwd && input.workspacePaths?.[0] !== WORKTREE ? { Cwd: WORKTREE } : {}
    // No decision reads as a denial here, so what its sandbox and edit mode already hold is said out loud too.
    const allowed = (overwrite: Record<string, unknown> = {}) => ({ decision: 'allow', ...(Object.keys({ ...overwrite, ...elsewhere }).length ? { overwrite: { ...overwrite, ...elsewhere } } : {}) })
    if (check.action === 'pass') answer = allowed()
    if (check.action === 'allow') answer = allowed(check.overwrite)
    if (check.action === 'deny') answer = { decision: 'deny', reason: check.reason }
    if (check.action === 'ask') {
      const id = randomUUID()
      write({ id, event: 'PermissionRequest', ...base })
      const credential = readCredential<{ mail: MailCredential; socket?: string; endpoint?: CoreEndpoint }>(credentialFile)
      const reply = await coreRequest(credential.endpoint ?? credential.socket ?? (() => { throw new Error('Missing core endpoint') })(), credential.mail, 'permission', {
        id, tool: base.tool, input: input.toolCall?.args, session: base.session,
      }, { id, timeout: 3_500_000 }) as { allow: boolean }
      answer = reply.allow === true ? allowed() : { decision: 'deny', reason: 'The human declined this request.' }
    }
  }
} catch {
  // Ordinary observation hooks never block the agent. Permission transport failures always deny.
  if (CHECKED) answer = { decision: 'deny', reason: 'Shepherdr could not verify approval. Ask again after it reconnects.' }
}
console.log(JSON.stringify(answer))

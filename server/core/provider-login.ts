import { createHash } from 'node:crypto'
import type { CoreFiles } from './files.ts'
import type { AgentKind } from './model.ts'

/** Each CLI's own word on who it is signed in as. Only a hash of it is ever kept. */
const WHO: Partial<Record<AgentKind, string[]>> = {
  claude: ['claude', 'auth', 'status', '--json'],
  codex: ['codex', 'login', 'status'],
}
/** The smallest real request each CLI can make: its own answer is the only proof its account can work again. */
const PROBE: Partial<Record<AgentKind, string[]>> = {
  claude: ['claude', '-p', 'Reply with exactly: OK', '--model', 'haiku', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--tools', '', '--output-format', 'json'],
  codex: ['codex', 'exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', 'Reply with exactly: OK'],
}
const FRESH = 15_000

/** What a live login is now and whether its provider answers. Used only while a task is out of allowance or on its backup. */
export class CoreProviderLogin {
  private seen = new Map<string, { at: number; mark?: string }>()
  constructor(private files: CoreFiles) {}
  /** Changes when the CLI's login changes, however that happened. Nothing known: nothing to compare. */
  async mark(machine: string, kind: AgentKind, now = Date.now()) {
    const key = `${machine}:${kind}`, saved = this.seen.get(key)
    if (saved && now - saved.at < FRESH) return saved.mark
    let mark: string | undefined
    try {
      if (WHO[kind]) {
        const text = (await this.files.exec(machine, WHO[kind]!, undefined, undefined, 20)).toString('utf8')
        mark = createHash('sha256').update(identity(text)).digest('hex')
      }
    } catch { /* A CLI that can't say who it is says nothing about a change. */ }
    this.seen.set(key, { at: now, mark })
    return mark
  }
  /** True only on a clear answer. A failure of any kind says it can't go on yet. */
  async available(machine: string, kind: AgentKind) {
    if (!PROBE[kind]) return false
    try {
      const text = (await this.files.exec(machine, PROBE[kind]!, undefined, undefined, 90)).toString('utf8')
      if (kind !== 'claude') return true
      return JSON.parse(text).is_error === false
    } catch { return false }
  }
}

/** Only what names the account, so a change of plan wording or path isn't a change of login. */
function identity(text: string) {
  try {
    const { loggedIn, email, orgId } = JSON.parse(text)
    return JSON.stringify({ loggedIn, email, orgId })
  } catch { return text }
}
